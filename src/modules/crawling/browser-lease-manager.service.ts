import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { delayMs } from '../../utils/async-delay.utils';
import { LoggerUtils } from '../../utils/logger.utils';

const execFileAsync = promisify(execFile);
const BROWSER_PROCESS_NAME_REGEX = /chromium|chrome|crashpad/i;

interface BrowserSessionLike {
  closeBrowser(): Promise<void>;
}

interface ProcessSnapshotRow {
  pid: number;
  ppid: number;
  stat: string;
  command: string;
}

@Injectable()
export class BrowserLeaseManagerService implements OnApplicationShutdown {
  private readonly logger = LoggerUtils.getContextLogger(
    BrowserLeaseManagerService.name,
  );

  private activeLeases = 0;
  private readonly leaseWaitQueue: Array<() => void> = [];
  private readonly trackedBrowserPids = new Set<number>();
  private readonly closeTimeoutMs = 10_000;
  private readonly forceKillWaitMs = 5_000;
  private shuttingDown = false;

  private wakeLeaseWaiters(): void {
    while (this.leaseWaitQueue.length > 0) {
      const next = this.leaseWaitQueue.shift();
      next?.();
    }
  }

  private resolvePid(session: unknown): number | null {
    try {
      const pid = (
        session as unknown as {
          browser?: { process?: () => { pid?: number | null } | null };
        }
      ).browser?.process?.()?.pid;
      return typeof pid === 'number' && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  private async waitForLeaseSlot(label: string): Promise<void> {
    const waitStartedAt = Date.now();
    let warned = false;

    for (;;) {
      if (this.shuttingDown) {
        throw new Error(`${label}: browser lease manager is shutting down`);
      }

      if (this.activeLeases === 0) {
        this.activeLeases = 1;

        const waitedMs = Date.now() - waitStartedAt;
        if (waitedMs >= 1000) {
          LoggerUtils.debugDev(
            BrowserLeaseManagerService.name,
            `${label}: acquired browser lease after waiting ${waitedMs}ms`,
          );
        }
        return;
      }

      if (!warned && Date.now() - waitStartedAt >= 5000) {
        warned = true;
        this.logger.warn(
          `${label}: waiting for browser lease >5s (active=${this.activeLeases}, queue=${this.leaseWaitQueue.length})`,
        );
      }

      await new Promise<void>((resolve) => {
        this.leaseWaitQueue.push(resolve);
      });

      if (this.shuttingDown) {
        throw new Error(`${label}: browser lease manager is shutting down`);
      }
    }
  }

  private releaseLease(): void {
    this.activeLeases = Math.max(0, this.activeLeases - 1);
    const next = this.leaseWaitQueue.shift();
    if (next) next();
  }

  private async isProcessAlive(pid: number): Promise<boolean> {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      return code !== 'ESRCH';
    }
  }

  private async collectProcessTree(rootPid: number): Promise<number[]> {
    try {
      const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=,ppid=']);
      const childrenByParent = new Map<number, number[]>();

      for (const rawLine of stdout.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;

        const [pidText, ppidText] = line.split(/\s+/, 2);
        const pid = Number(pidText);
        const ppid = Number(ppidText);

        if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;

        const children = childrenByParent.get(ppid) ?? [];
        children.push(pid);
        childrenByParent.set(ppid, children);
      }

      const stack = [rootPid];
      const seen = new Set<number>();
      const descendants: number[] = [];

      while (stack.length > 0) {
        const current = stack.pop();
        if (current == null || seen.has(current)) continue;
        seen.add(current);
        descendants.push(current);

        const children = childrenByParent.get(current) ?? [];
        for (const child of children) {
          if (!seen.has(child)) {
            stack.push(child);
          }
        }
      }

      return descendants;
    } catch {
      return [rootPid];
    }
  }

  private async readProcessSnapshot(): Promise<ProcessSnapshotRow[]> {
    try {
      const { stdout } = await execFileAsync('ps', [
        '-A',
        '-o',
        'pid=,ppid=,stat=,comm=',
      ]);

      const rows: ProcessSnapshotRow[] = [];
      for (const rawLine of stdout.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;

        const parts = line.split(/\s+/, 4);
        if (parts.length < 4) continue;

        const pid = Number(parts[0]);
        const ppid = Number(parts[1]);
        const stat = parts[2] ?? '';
        const command = parts[3] ?? '';

        if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;

        rows.push({ pid, ppid, stat, command });
      }

      return rows;
    } catch {
      return [];
    }
  }

  private async collectBrowserDescendants(): Promise<ProcessSnapshotRow[]> {
    const snapshot = await this.readProcessSnapshot();
    if (snapshot.length === 0) return [];

    const childrenByParent = new Map<number, ProcessSnapshotRow[]>();
    for (const row of snapshot) {
      const children = childrenByParent.get(row.ppid) ?? [];
      children.push(row);
      childrenByParent.set(row.ppid, children);
    }

    const stack = [process.pid];
    const seen = new Set<number>();
    const descendants: ProcessSnapshotRow[] = [];

    while (stack.length > 0) {
      const current = stack.pop();
      if (current == null || seen.has(current)) continue;
      seen.add(current);

      const children = childrenByParent.get(current) ?? [];
      for (const child of children) {
        if (!seen.has(child.pid)) {
          stack.push(child.pid);
        }

        if (BROWSER_PROCESS_NAME_REGEX.test(child.command)) {
          descendants.push(child);
        }
      }
    }

    return descendants;
  }

  private async forceKillProcessTree(
    pid: number,
    label: string,
  ): Promise<void> {
    const tree = await this.collectProcessTree(pid);

    for (const currentPid of tree.reverse()) {
      try {
        process.kill(currentPid, 'SIGKILL');
      } catch {
        // Ignore ESRCH and permission issues during cleanup; best-effort only.
      }
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < this.forceKillWaitMs) {
      if (!(await this.isProcessAlive(pid))) {
        return;
      }
      await delayMs(100);
    }

    this.logger.warn(
      `${label}: browser process ${pid} still alive after SIGKILL`,
    );
  }

  private async closeBrowserSession(
    label: string,
    session: BrowserSessionLike,
    leaseStartPids: Set<number>,
  ): Promise<void> {
    const pid = this.resolvePid(session);
    if (pid != null) {
      this.trackedBrowserPids.add(pid);
    }

    const observedBeforeClose = await this.collectBrowserDescendants();
    for (const row of observedBeforeClose) {
      if (!leaseStartPids.has(row.pid)) {
        this.trackedBrowserPids.add(row.pid);
      }
    }

    const closePromise = Promise.resolve()
      .then(() => session.closeBrowser())
      .catch((error) => {
        this.logger.warn(
          `${label}: closeBrowser failed: ${(error as Error).message}`,
        );
      });

    let timeoutHandle: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<boolean>((resolve) => {
      timeoutHandle = setTimeout(() => resolve(true), this.closeTimeoutMs);
    });

    const timedOut = await Promise.race([
      closePromise.then(() => false),
      timeoutPromise,
    ]);
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }

    if (timedOut) {
      this.logger.warn(
        `${label}: closeBrowser timed out after ${this.closeTimeoutMs}ms`,
      );
    }

    const observedAfterClose = await this.collectBrowserDescendants();
    const observedAfterSet = new Set(observedAfterClose.map((row) => row.pid));

    for (const trackedPid of [...this.trackedBrowserPids]) {
      if (!observedAfterSet.has(trackedPid)) {
        this.trackedBrowserPids.delete(trackedPid);
      }
    }

    const leakedRows = observedAfterClose.filter((row) =>
      this.trackedBrowserPids.has(row.pid),
    );

    for (const row of leakedRows) {
      if (row.stat.startsWith('Z')) {
        this.logger.warn(
          `${label}: browser pid ${row.pid} is zombie (${row.command}); waiting for parent reap`,
        );
        continue;
      }

      const stillAlive = await this.isProcessAlive(row.pid);
      if (!stillAlive) {
        this.trackedBrowserPids.delete(row.pid);
        continue;
      }

      this.logger.warn(
        `${label}: browser pid ${row.pid} (${row.command}) still alive after closeBrowser; forcing cleanup`,
      );
      await this.forceKillProcessTree(row.pid, label);

      if (!(await this.isProcessAlive(row.pid))) {
        this.trackedBrowserPids.delete(row.pid);
      }
    }
  }

  async runWithLease<TSession, TResult>(
    label: string,
    session: TSession,
    task: (session: TSession) => Promise<TResult>,
  ): Promise<TResult> {
    const leaseStartPids = new Set(
      (await this.collectBrowserDescendants()).map((row) => row.pid),
    );

    await this.waitForLeaseSlot(label);
    try {
      return await task(session);
    } finally {
      await this.closeBrowserSession(
        label,
        session as BrowserSessionLike,
        leaseStartPids,
      );
      this.releaseLease();
    }
  }

  async waitForIdle(timeoutMs = 15_000, pollMs = 200): Promise<void> {
    const startedAt = Date.now();

    while (this.activeLeases > 0 || this.trackedBrowserPids.size > 0) {
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(
          `browser lease manager still busy after ${timeoutMs}ms (active=${this.activeLeases}, tracked=${this.trackedBrowserPids.size})`,
        );
      }

      await delayMs(pollMs);
    }
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.shuttingDown = true;
    this.wakeLeaseWaiters();

    const shutdownLabel = `shutdown(${signal ?? 'unknown'})`;
    const waitTimeoutMs = this.closeTimeoutMs + this.forceKillWaitMs + 5000;

    try {
      await this.waitForIdle(waitTimeoutMs);
    } catch (error) {
      this.logger.warn(
        `${shutdownLabel}: browser leases did not settle within ${waitTimeoutMs}ms: ${(error as Error).message}`,
      );
    }

    if (this.trackedBrowserPids.size > 0) {
      this.logger.warn(
        `${shutdownLabel}: forcing cleanup for ${this.trackedBrowserPids.size} tracked browser process(es)`,
      );

      const pids = [...this.trackedBrowserPids];
      this.trackedBrowserPids.clear();

      for (const pid of pids) {
        await this.forceKillProcessTree(pid, shutdownLabel);
      }
    }

    const descendants = await this.collectBrowserDescendants();
    for (const row of descendants) {
      if (row.stat.startsWith('Z')) {
        this.logger.warn(
          `${shutdownLabel}: browser pid ${row.pid} remains zombie (${row.command})`,
        );
        this.trackedBrowserPids.add(row.pid);
        continue;
      }

      await this.forceKillProcessTree(row.pid, shutdownLabel);
    }
  }

  async getDebugState(): Promise<{
    activeLeases: number;
    queuedWaiters: number;
    trackedBrowserPids: number[];
    discoveredBrowserDescendants: Array<{
      pid: number;
      ppid: number;
      stat: string;
      command: string;
    }>;
    shuttingDown: boolean;
    closeTimeoutMs: number;
    forceKillWaitMs: number;
  }> {
    const descendants = await this.collectBrowserDescendants();

    return {
      activeLeases: this.activeLeases,
      queuedWaiters: this.leaseWaitQueue.length,
      trackedBrowserPids: [...this.trackedBrowserPids].sort((a, b) => a - b),
      discoveredBrowserDescendants: descendants
        .sort((a, b) => a.pid - b.pid)
        .slice(0, 50),
      shuttingDown: this.shuttingDown,
      closeTimeoutMs: this.closeTimeoutMs,
      forceKillWaitMs: this.forceKillWaitMs,
    };
  }
}
