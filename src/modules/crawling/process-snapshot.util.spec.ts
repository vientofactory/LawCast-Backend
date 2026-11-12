import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseProcStat,
  readLinuxProcessSnapshot,
} from './process-snapshot.util';

describe('procfs process snapshots', () => {
  it('parses names with whitespace and parentheses and retains zombie state', () => {
    expect(parseProcStat('47 (chrome (worker)) Z 7 0 0')).toEqual({
      pid: 47,
      ppid: 7,
      stat: 'Z',
      command: 'chrome (worker)',
    });
  });

  it('rejects malformed process identities', () => {
    for (const value of [
      'invalid',
      '0 (chrome) S 7',
      '7 (chrome) S -1',
      '7 (chrome) S',
      '7 chrome S 1',
    ])
      expect(parseProcStat(value)).toBeUndefined();
  });

  it('skips exited and mismatched processes and ignores non-PID entries', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lawcast-proc-'));
    try {
      for (const name of ['7', '47', '48', '49', 'self'])
        await mkdir(path.join(root, name));
      await writeFile(path.join(root, '7/stat'), '7 (node) S 1 0');
      await writeFile(path.join(root, '47/stat'), '47 (chromium) Z 7 0');
      await writeFile(path.join(root, '48/stat'), '500 (unrelated) S 7 0');
      await writeFile(path.join(root, 'self/stat'), '88 (ignored) S 1 0');
      expect(
        (await readLinuxProcessSnapshot(root)).sort((a, b) => a.pid - b.pid),
      ).toEqual([
        { pid: 7, ppid: 1, stat: 'S', command: 'node' },
        { pid: 47, ppid: 7, stat: 'Z', command: 'chromium' },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('propagates unavailable procfs so the caller can use its portable fallback', async () => {
    await expect(
      readLinuxProcessSnapshot('/path/that/does/not/exist'),
    ).rejects.toThrow();
  });
});
