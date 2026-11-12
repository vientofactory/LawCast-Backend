import { StatsReadTrace } from './stats-read-trace';

describe('statistics read tracing', () => {
  afterEach(() => jest.useRealTimers());
  it('does not log fast successful reads', async () => {
    const emit = jest.fn();
    const trace = new StatsReadTrace('full', emit);
    expect(await trace.measure('archiveCount', async () => 42)).toBe(42);
    trace.finish();
    expect(emit).not.toHaveBeenCalled();
  });
  it('reports the pending dependency before a stalled request finishes', async () => {
    jest.useFakeTimers({ doNotFake: ['performance'] });
    const emit = jest.fn();
    const trace = new StatsReadTrace('full', emit);
    let resolve: (value: number) => void;
    const pending = trace.measure(
      'ollama',
      () => new Promise<number>((done) => (resolve = done)),
    );
    await jest.advanceTimersByTimeAsync(1000);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'stats_read_pending',
        stages: [
          expect.objectContaining({ name: 'ollama', status: 'pending' }),
        ],
      }),
    );
    resolve(42);
    expect(await pending).toBe(42);
    trace.finish();
    expect(jest.getTimerCount()).toBe(0);
  });
  it('preserves dependency errors and emits no payload or error details', async () => {
    const emit = jest.fn();
    const trace = new StatsReadTrace('home', emit);
    const error = new Error('private query details');
    await expect(
      trace.measure('cache', async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    trace.finish(true);
    trace.finish(true);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(emit.mock.calls)).not.toContain(
      'private query details',
    );
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        failed: true,
        stages: [expect.objectContaining({ name: 'cache', status: 'error' })],
      }),
    );
  });
  it('does not let a failed telemetry sink change results or errors', async () => {
    const trace = new StatsReadTrace('full', () => {
      throw new Error('sink failed');
    });
    expect(await trace.measure('webhooks', () => 7)).toBe(7);
    expect(() => trace.finish(true)).not.toThrow();
  });
});
