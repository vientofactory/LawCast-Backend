import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { delayMs } from '../../utils/async-delay.utils';
import { LoggerUtils } from '../../utils/logger.utils';

const execFileAsync = promisify(execFile);

interface BrowserSessionLike {
  closeBrowser(): Promise<void>;
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
  ): Promise<void> {
    const pid = this.resolvePid(session);
    if (pid != null) {
      this.trackedBrowserPids.add(pid);
    }

    const closePromise = Promise.resolve()
      .then(() => session.closeBrowser())
      .catch((error) => {
        this.logger.warn(
          `${label}: closeBrowser failed: ${(error as Error).message}`,
        );
      });

    const timedOut = await Promise.race([
      closePromise.then(() => false),
      delayMs(this.closeTimeoutMs).then(() => true),
    ]);

    if (timedOut) {
      this.logger.warn(
        `${label}: closeBrowser timed out after ${this.closeTimeoutMs}ms`,
      );
    }

    if (pid != null) {
      const stillAlive = await this.isProcessAlive(pid);
      if (stillAlive) {
        this.logger.warn(
          `${label}: browser pid ${pid} still alive after closeBrowser; forcing cleanup`,
        );
        await this.forceKillProcessTree(pid, label);
      }
      this.trackedBrowserPids.delete(pid);
    }
  }

  async runWithLease<TSession, TResult>(
    label: string,
    session: TSession,
    task: (session: TSession) => Promise<TResult>,
  ): Promise<TResult> {
    await this.waitForLeaseSlot(label);
    try {
      return await task(session);
    } finally {
      await this.closeBrowserSession(label, session as BrowserSessionLike);
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
  }

  async getDebugState(): Promise<{
    activeLeases: number;
    queuedWaiters: number;
    trackedBrowserPids: number[];
    closeTimeoutMs: number;
    forceKillWaitMs: number;
  }> {
    return {
      activeLeases: this.activeLeases,
      queuedWaiters: this.leaseWaitQueue.length,
      trackedBrowserPids: [...this.trackedBrowserPids].sort((a, b) => a - b),
      closeTimeoutMs: this.closeTimeoutMs,
      forceKillWaitMs: this.forceKillWaitMs,
    };
  }
}
