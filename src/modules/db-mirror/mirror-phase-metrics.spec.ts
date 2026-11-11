import { Logger } from '@nestjs/common';
import { measureMirrorPhase } from './mirror-phase-metrics';

function readFields(line: string): Record<string, string> {
  return Object.fromEntries(line.split(' | ').map((field) => field.split('=')));
}

describe('measureMirrorPhase', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reports synchronous blocking and preserves the work result', async () => {
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => {});
    const result = await measureMirrorPhase(
      'test.sqlite',
      'dump_wait',
      async () => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 70);
        return 'copied';
      },
    );

    expect(result).toBe('copied');
    const [start, finish] = log.mock.calls.map(([entry]) => readFields(entry));
    expect(log.mock.calls[0][0]).toBe(
      'event=db_mirror_phase_start | dumpFileName=test.sqlite | phase=dump_wait | executionContext=backend-main',
    );
    expect(start).toEqual({
      event: 'db_mirror_phase_start',
      executionContext: 'backend-main',
      dumpFileName: 'test.sqlite',
      phase: 'dump_wait',
    });
    expect(finish).toMatchObject({
      event: 'db_mirror_phase_finish',
      dumpFileName: 'test.sqlite',
      phase: 'dump_wait',
      status: 'ok',
    });
    expect(finish.durationMs).toMatch(/^\d+ ms$/);
    expect(Number.parseInt(finish.durationMs, 10)).toBeGreaterThanOrEqual(60);
    expect(finish.eventLoopMaxDelayMs).toMatch(/^\d+ ms$/);
    expect(
      Number.parseInt(finish.eventLoopMaxDelayMs, 10),
    ).toBeGreaterThanOrEqual(60);
    expect(finish.rssBeforeBytes).toMatch(/^\d+ \(\d+\.\d MiB\)$/);
    expect(Number.parseInt(finish.rssBeforeBytes, 10)).toBeGreaterThan(0);
    expect(
      Number.parseInt(finish.rssSampledPeakBytes, 10),
    ).toBeGreaterThanOrEqual(
      Math.max(
        Number.parseInt(finish.rssBeforeBytes, 10),
        Number.parseInt(finish.rssAfterBytes, 10),
      ),
    );
  });

  it('records a failed phase without replacing the original error', async () => {
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => {});
    const failure = new Error('upload failed');
    await expect(
      measureMirrorPhase('test.sqlite', 'upload', () =>
        Promise.reject(failure),
      ),
    ).rejects.toBe(failure);

    expect(readFields(log.mock.calls[1][0])).toMatchObject({
      event: 'db_mirror_phase_finish',
      phase: 'upload',
      executionContext: 'backend-main',
      status: 'error',
    });
  });
});
