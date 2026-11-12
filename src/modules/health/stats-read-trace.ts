import { performance } from 'node:perf_hooks';

type Stage = {
  name: string;
  startedAtMs: number;
  invokeMs?: number;
  durationMs?: number;
  status: 'pending' | 'ok' | 'error';
};
const SLOW_MS = 1000;
let nextTraceId = 0;

/** Timings are inclusive wall time, not exclusive CPU time or SQL execution time. */
export class StatsReadTrace {
  private readonly traceId = `${process.pid}-${++nextTraceId}`;
  private readonly startedAt = performance.now();
  private readonly utilization = performance.eventLoopUtilization();
  private readonly stages: Stage[] = [];
  private readonly timer: NodeJS.Timeout;
  private finished = false;

  constructor(
    private readonly view: 'full' | 'home',
    private readonly emit: (row: Record<string, unknown>) => void,
  ) {
    this.timer = setTimeout(() => this.report('stats_read_pending'), SLOW_MS);
    this.timer.unref();
  }

  async measure<T>(name: string, work: () => T | Promise<T>): Promise<T> {
    const start = performance.now();
    const stage: Stage = {
      name,
      startedAtMs: start - this.startedAt,
      status: 'pending',
    };
    this.stages.push(stage);
    try {
      const result = work();
      stage.invokeMs = performance.now() - start;
      const value = await result;
      stage.status = 'ok';
      return value;
    } catch (error) {
      stage.status = 'error';
      throw error;
    } finally {
      stage.durationMs = performance.now() - start;
      stage.invokeMs ??= stage.durationMs;
    }
  }

  finish(failed = false): void {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.timer);
    if (failed || performance.now() - this.startedAt >= SLOW_MS)
      this.report('stats_read_finished', failed);
  }

  private report(event: string, failed = false): void {
    const elapsedMs = performance.now() - this.startedAt;
    try {
      this.emit({
        event,
        traceId: this.traceId,
        view: this.view,
        elapsedMs: Math.round(elapsedMs),
        failed,
        timerLagMs:
          event === 'stats_read_pending'
            ? Math.max(0, Math.round(elapsedMs - SLOW_MS))
            : undefined,
        eventLoopUtilization: performance.eventLoopUtilization(this.utilization)
          .utilization,
        stages: this.stages.map((stage) => ({ ...stage })),
      });
    } catch {
      // Observability must never change the result or error of a statistics read.
    }
  }
}
