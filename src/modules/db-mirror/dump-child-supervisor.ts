import { fork } from 'node:child_process';
import type { MirrorMetricFields } from './mirror-phase-metrics';

type DumpChildOptions = {
  entrypoint: string;
  sourcePath: string;
  dumpPath: string;
  dumpFileName: string;
  busyTimeoutMs: number;
  timeoutMs: number;
  signal: AbortSignal;
  onMetric: (metric: MirrorMetricFields) => void;
};

const MAX_METRICS = 6;
const MAX_RETAINED_TABLES = 6;
const PHASES = new Set(['copy', 'prune', 'recompact']);

function childError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseMetric(
  payload: Record<string, unknown>,
  dumpFileName: string,
  pid: number | undefined,
): MirrorMetricFields | undefined {
  const {
    event,
    phase,
    status,
    durationMs,
    rssBeforeBytes,
    rssAfterBytes,
    processRssHighWaterBytes,
  } = payload;
  if (
    typeof phase !== 'string' ||
    !PHASES.has(phase) ||
    payload.executionContext !== 'dump-child' ||
    payload.dumpFileName !== dumpFileName ||
    !isCount(payload.pid) ||
    payload.pid !== pid ||
    (event !== 'db_mirror_phase_start' && event !== 'db_mirror_phase_finish')
  ) {
    return undefined;
  }

  const context = {
    event,
    dumpFileName,
    phase,
    executionContext: 'dump-child',
    pid: payload.pid,
  };
  if (event === 'db_mirror_phase_start') return context;
  if (
    (status !== 'ok' && status !== 'error') ||
    !isCount(durationMs) ||
    !isCount(rssBeforeBytes) ||
    !isCount(rssAfterBytes) ||
    !isCount(processRssHighWaterBytes)
  ) {
    return undefined;
  }
  return {
    ...context,
    status,
    durationMs,
    rssBeforeBytes,
    rssAfterBytes,
    processRssHighWaterBytes,
  };
}

function parseRetainedTables(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_RETAINED_TABLES)
    return undefined;
  if (
    !value.every(
      (name: unknown): name is string =>
        typeof name === 'string' && /^[a-z_]{1,64}$/.test(name),
    )
  ) {
    return undefined;
  }
  return new Set(value).size === value.length ? value : undefined;
}

export async function superviseDumpChild(
  options: DumpChildOptions,
): Promise<string[]> {
  const cancelled = () =>
    childError(
      'DUMP_CHILD_CANCELLED',
      'Database dump cancelled during shutdown',
    );
  if (options.signal.aborted) throw cancelled();

  return new Promise((resolve, reject) => {
    const child = fork(
      options.entrypoint,
      [
        options.sourcePath,
        options.dumpPath,
        options.dumpFileName,
        String(options.busyTimeoutMs),
      ],
      {
        // Keep operator-controlled temp paths, but do not inherit credentials or NODE_OPTIONS.
        env: {
          TZ: process.env.TZ,
          TMPDIR: process.env.TMPDIR,
          TMP: process.env.TMP,
          TEMP: process.env.TEMP,
          SQLITE_TMPDIR: process.env.SQLITE_TMPDIR,
        },
        execArgv: ['--max-old-space-size=128'],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      },
    );
    let failure: Error | undefined;
    let retainedTables: string[] | undefined;
    let metricCount = 0;
    let terminalMessage = false;

    function stop(error: Error): void {
      failure ??= error;
      // Native SQLite work cannot poll for cancellation. Reap the child before touching its file.
      if (child.pid && !child.killed) child.kill('SIGKILL');
    }

    const invalid = () =>
      stop(
        childError(
          'DUMP_CHILD_PROTOCOL',
          'Invalid database dump child message',
        ),
      );
    const abort = () => stop(cancelled());
    const deadline = setTimeout(() => {
      stop(
        childError(
          'DUMP_CHILD_TIMEOUT',
          `Database dump exceeded ${options.timeoutMs} ms`,
        ),
      );
    }, options.timeoutMs);
    deadline.unref();

    child.on('error', (error) => {
      stop(error);
    });
    child.on('message', (message: unknown) => {
      if (failure) return;
      if (
        !message ||
        typeof message !== 'object' ||
        Array.isArray(message) ||
        terminalMessage
      ) {
        invalid();
        return;
      }
      const payload = message as Record<string, unknown>;
      switch (payload.type) {
        case 'metric': {
          const metric = parseMetric(payload, options.dumpFileName, child.pid);
          if (!metric || ++metricCount > MAX_METRICS) {
            invalid();
            return;
          }
          try {
            options.onMetric(metric);
          } catch {
            // A metrics sink is not part of the child result contract.
          }
          return;
        }
        case 'result':
          retainedTables = parseRetainedTables(payload.retainedTables);
          if (!retainedTables) {
            invalid();
            return;
          }
          terminalMessage = true;
          return;
        case 'failure':
          if (typeof payload.message !== 'string') {
            invalid();
            return;
          }
          terminalMessage = true;
          failure = childError(
            typeof payload.code === 'string' &&
              /^[A-Z0-9_]{1,64}$/.test(payload.code)
              ? payload.code
              : 'DUMP_CHILD_FAILURE',
            payload.message.slice(0, 1024).replace(/[\r\n\t]/g, ' '),
          );
          return;
        default:
          invalid();
      }
    });
    child.once('close', (code, signal) => {
      clearTimeout(deadline);
      options.signal.removeEventListener('abort', abort);
      if (!failure && code === 0 && retainedTables) {
        resolve(retainedTables);
      } else {
        reject(
          failure ??
            childError(
              'DUMP_CHILD_EXIT',
              `Database dump child exited (${signal ?? code}) without a successful result`,
            ),
        );
      }
    });

    options.signal.addEventListener('abort', abort, { once: true });
  });
}
