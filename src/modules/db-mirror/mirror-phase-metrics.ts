import { performance } from 'node:perf_hooks';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { LoggerUtils } from '../../utils/logger.utils';

type MirrorPhase = 'copy' | 'prune' | 'recompact' | 'upload' | 'dump_wait';

const SAMPLE_INTERVAL_MS = 50;
export type MirrorMetricFields = Record<string, string | number>;

export function logMirrorMetric(metric: MirrorMetricFields): void {
  const fields = Object.entries(metric).map(([key, value]) => {
    const field = `${key}=${value}`;
    if (typeof value !== 'number') return field;
    if (key.endsWith('Bytes')) {
      return `${field} (${(value / 1_048_576).toFixed(1)} MiB)`;
    }
    return key.endsWith('Ms') ? `${field} ms` : field;
  });
  LoggerUtils.log('DatabaseMirrorMetrics', fields.join(' | '));
}

export async function measureMirrorPhase<T>(
  dumpFileName: string,
  phase: MirrorPhase,
  work: () => Promise<T>,
): Promise<T> {
  logMirrorMetric({
    event: 'db_mirror_phase_start',
    dumpFileName,
    phase,
    executionContext: 'backend-main',
  });

  const rssBeforeBytes = process.memoryUsage.rss();
  let rssSampledPeakBytes = rssBeforeBytes;
  let eventLoopMaxDelayMs = 0;
  const startedAt = performance.now();
  let previousTick = startedAt;
  const sampler = setInterval(() => {
    const now = performance.now();
    eventLoopMaxDelayMs = Math.max(
      eventLoopMaxDelayMs,
      now - previousTick - SAMPLE_INTERVAL_MS,
    );
    previousTick = now;
    rssSampledPeakBytes = Math.max(
      rssSampledPeakBytes,
      process.memoryUsage.rss(),
    );
  }, SAMPLE_INTERVAL_MS);
  sampler.unref();

  // Queue a probe before SQL can block, even if the phase is too short for an interval tick.
  const firstTurn = nextTurn().then(() => {
    eventLoopMaxDelayMs = Math.max(
      eventLoopMaxDelayMs,
      performance.now() - startedAt,
    );
  });

  let status: 'ok' | 'error' = 'error';
  try {
    const result = await work();
    status = 'ok';
    return result;
  } finally {
    const durationMs = performance.now() - startedAt;
    const rssAfterBytes = process.memoryUsage.rss();
    // Include the last interval even if a synchronous call ended before its timer ran.
    eventLoopMaxDelayMs = Math.max(
      eventLoopMaxDelayMs,
      startedAt + durationMs - previousTick - SAMPLE_INTERVAL_MS,
    );
    clearInterval(sampler);
    await firstTurn;

    logMirrorMetric({
      event: 'db_mirror_phase_finish',
      dumpFileName,
      phase,
      executionContext: 'backend-main',
      status,
      durationMs: Math.round(durationMs),
      rssBeforeBytes,
      rssAfterBytes,
      rssSampledPeakBytes: Math.max(rssSampledPeakBytes, rssAfterBytes),
      processRssHighWaterBytes: process.resourceUsage().maxRSS * 1024,
      eventLoopMaxDelayMs: Math.round(eventLoopMaxDelayMs),
    });
  }
}
