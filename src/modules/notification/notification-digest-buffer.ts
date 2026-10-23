import { BatchProcessingOptions } from '../shared/batch-processing.service';

/** Coalesce adjacent producer batches before either notification channel sends. */
export class NotificationDigestBuffer<T> {
  private readonly quietPeriodMs = 30_000;
  private readonly maxWaitMs = 120_000;
  private pending: {
    items: T[];
    options: BatchProcessingOptions;
    batchRunId: string;
    startedAt: number;
  } | null = null;
  private readonly inFlight = new Set<Promise<unknown>>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly generateId: () => string,
    private readonly dispatch: (
      items: T[],
      options: BatchProcessingOptions,
      batchRunId: string,
    ) => Promise<unknown>,
  ) {}

  enqueue(items: T[], options: BatchProcessingOptions): string {
    if (items.length === 0) return this.generateId();

    // Keep the first producer's execution options and job identity for the digest.
    this.pending ??= {
      items: [],
      options: { ...options },
      batchRunId: this.generateId(),
      startedAt: Date.now(),
    };
    this.pending.items.push(...items);
    if (this.timer) clearTimeout(this.timer);
    const remainingMs = this.maxWaitMs - (Date.now() - this.pending.startedAt);
    this.timer = setTimeout(
      () => void this.flush(),
      Math.max(0, Math.min(this.quietPeriodMs, remainingMs)),
    );
    return this.pending.batchRunId;
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const pending = this.pending;
    // Detach before dispatch so arrivals during delivery form the next digest.
    this.pending = null;
    if (pending) {
      const completion = this.dispatch(
        pending.items,
        pending.options,
        pending.batchRunId,
      );
      this.inFlight.add(completion);
      void completion.finally(() => this.inFlight.delete(completion));
    }
    await Promise.all(this.inFlight);
  }
}
