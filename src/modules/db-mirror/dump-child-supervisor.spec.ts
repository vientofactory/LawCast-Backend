import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { superviseDumpChild } from './dump-child-supervisor';

describe('superviseDumpChild', () => {
  let dir: string;
  const sourcePath = 'source.sqlite';
  const dumpPath = 'dump.sqlite';
  const dumpFileName = 'dump.sqlite';

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lawcast-child-supervisor-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function makeChild(script: string): Promise<string> {
    const entrypoint = path.join(dir, 'fixture.cjs');
    await fs.writeFile(entrypoint, script);
    return entrypoint;
  }

  function run(
    entrypoint: string,
    overrides: Partial<Parameters<typeof superviseDumpChild>[0]> = {},
  ) {
    return superviseDumpChild({
      entrypoint,
      sourcePath,
      dumpPath,
      dumpFileName,
      busyTimeoutMs: 5000,
      timeoutMs: 2000,
      signal: new AbortController().signal,
      onMetric: jest.fn(),
      ...overrides,
    });
  }

  const start = `process.send({
    type: 'metric',
    event: 'db_mirror_phase_start',
    dumpFileName: process.argv[4],
    phase: 'copy',
    executionContext: 'dump-child',
    pid: process.pid,
  });`;
  const success = `process.send({type:'result', retainedTables:['notice_archives']});`;

  it('does not pass parent secrets or Node options and isolates metrics sink errors', async () => {
    const entrypoint = await makeChild(`
      if (process.env.LAWCAST_PARENT_ONLY_TEST || process.env.NODE_OPTIONS)
        throw new Error('Inherited parent environment');
      ${start}
      ${success}
    `);
    const key = 'LAWCAST_PARENT_ONLY_TEST';
    const original = process.env[key];
    process.env[key] = 'fixture-secret';
    const onMetric = jest.fn(() => {
      throw new Error('Metrics sink failed');
    });
    try {
      await expect(run(entrypoint, { onMetric })).resolves.toEqual([
        'notice_archives',
      ]);
      expect(onMetric).toHaveBeenCalledTimes(1);
    } finally {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });

  it.each([
    ['no result', ''],
    ['signal crash', "process.kill(process.pid, 'SIGKILL');"],
    ['nonzero exit after result', success + 'process.exitCode = 7;'],
  ])('rejects a child exit with %s', async (_label, script) => {
    await expect(run(await makeChild(script))).rejects.toMatchObject({
      code: 'DUMP_CHILD_EXIT',
    });
  });

  it.each([
    ['an array', 'process.send([]);'],
    ['a malformed metric', "process.send({type:'metric', event:'unknown'});"],
    ['an invalid result', "process.send({type:'result', retainedTables:[7]});"],
    ['duplicate terminal messages', success + success],
    ['excess metrics', start.repeat(7)],
  ])('rejects %s without breaking the parent', async (_label, script) => {
    const entrypoint = await makeChild(script + 'setInterval(() => {}, 1000);');
    await expect(run(entrypoint)).rejects.toMatchObject({
      code: 'DUMP_CHILD_PROTOCOL',
    });
    await nextTurn();
  });

  it('times out a child that returns a result but does not exit', async () => {
    const entrypoint = await makeChild(
      success + 'setInterval(() => {}, 1000);',
    );
    await expect(run(entrypoint, { timeoutMs: 150 })).rejects.toMatchObject({
      code: 'DUMP_CHILD_TIMEOUT',
    });
  });

  it('reaps a CPU-bound child on cancellation before settling the result', async () => {
    const entrypoint = await makeChild(start + 'while (true) {}');
    const controller = new AbortController();
    let pid: number;
    await expect(
      run(entrypoint, {
        signal: controller.signal,
        onMetric: (metric) => {
          pid = Number(metric.pid);
          controller.abort();
        },
      }),
    ).rejects.toMatchObject({ code: 'DUMP_CHILD_CANCELLED' });
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
