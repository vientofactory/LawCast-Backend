import { readdir, readFile } from 'node:fs/promises';

export interface ProcessSnapshotRow {
  pid: number;
  ppid: number;
  stat: string;
  command: string;
}

/** Parse procfs without assuming that a process name contains no spaces or parentheses. */
export function parseProcStat(value: string): ProcessSnapshotRow | undefined {
  const opening = value.indexOf('(');
  const closing = value.lastIndexOf(')');
  if (opening < 1 || closing <= opening) return;
  const pid = Number(value.slice(0, opening).trim());
  const [stat, parent] = value
    .slice(closing + 1)
    .trim()
    .split(/\s+/);
  const ppid = Number(parent);
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !Number.isSafeInteger(ppid) ||
    ppid < 0 ||
    !stat ||
    stat.length !== 1
  )
    return;
  return { pid, ppid, stat, command: value.slice(opening + 1, closing) };
}

/** Avoid fork/exec from a large browser-owning parent; bound pending filesystem work. */
export async function readLinuxProcessSnapshot(
  root = '/proc',
): Promise<ProcessSnapshotRow[]> {
  const names = (await readdir(root)).filter((name) => /^[1-9]\d*$/.test(name));
  const result: ProcessSnapshotRow[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, names.length) }, async () => {
      while (next < names.length) {
        const name = names[next++];
        try {
          const row = parseProcStat(
            await readFile(`${root}/${name}/stat`, 'utf8'),
          );
          if (row && row.pid === Number(name)) result.push(row);
        } catch {
          // Processes may exit or become inaccessible while the snapshot is read.
        }
      }
    }),
  );
  return result;
}
