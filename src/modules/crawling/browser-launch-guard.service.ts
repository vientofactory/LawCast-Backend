import { Injectable } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_CONSTANTS } from '../../config/app.config';
import { delayMs } from '../../utils/async-delay.utils';
import { LoggerUtils } from '../../utils/logger.utils';

@Injectable()
export class BrowserLaunchGuardService {
  private readonly logger = LoggerUtils.getContextLogger(
    BrowserLaunchGuardService.name,
  );

  // Internal Variables
  private activeBrowserSessions = 0;
  private readonly browserWaitQueue: Array<() => void> = [];
  private lastBrowserLaunchStartedAt = 0;
  private browserLaunchThrottle: Promise<void> = Promise.resolve();
  private resourceCooldownUntil = 0;

  // Environment Variables
  private readonly browserConcurrencyLimit =
    APP_CONSTANTS.CRAWLING.BROWSER_MAX_CONCURRENCY;
  private readonly browserLaunchRetryCount =
    APP_CONSTANTS.CRAWLING.BROWSER_LAUNCH_RETRY_COUNT;
  private readonly browserLaunchRetryDelayMs =
    APP_CONSTANTS.CRAWLING.BROWSER_LAUNCH_RETRY_DELAY_MS;
  private readonly browserMinLaunchIntervalMs =
    APP_CONSTANTS.CRAWLING.BROWSER_MIN_LAUNCH_INTERVAL_MS;
  private browserGlobalLockEnabled =
    APP_CONSTANTS.CRAWLING.BROWSER_GLOBAL_LOCK_ENABLED;
  private readonly browserGlobalLockWaitTimeoutMs =
    APP_CONSTANTS.CRAWLING.BROWSER_GLOBAL_LOCK_WAIT_TIMEOUT_MS;
  private readonly browserGlobalLockStaleMs =
    APP_CONSTANTS.CRAWLING.BROWSER_GLOBAL_LOCK_STALE_MS;
  private readonly browserResourceCooldownMs =
    APP_CONSTANTS.CRAWLING.BROWSER_RESOURCE_COOLDOWN_MS;
  private readonly browserSystemGuardEnabled =
    APP_CONSTANTS.CRAWLING.BROWSER_SYSTEM_GUARD_ENABLED;
  private readonly browserSystemGuardWaitTimeoutMs =
    APP_CONSTANTS.CRAWLING.BROWSER_SYSTEM_GUARD_WAIT_TIMEOUT_MS;
  private readonly browserSystemGuardCheckIntervalMs =
    APP_CONSTANTS.CRAWLING.BROWSER_SYSTEM_GUARD_CHECK_INTERVAL_MS;
  private readonly browserSystemGuardMaxPidsUsagePercent =
    APP_CONSTANTS.CRAWLING.BROWSER_SYSTEM_GUARD_MAX_PIDS_USAGE_PERCENT;
  private readonly browserSystemGuardMinMemAvailableMb =
    APP_CONSTANTS.CRAWLING.BROWSER_SYSTEM_GUARD_MIN_MEM_AVAILABLE_MB;

  private isSystemGuardActiveOnCurrentPlatform(): boolean {
    return this.browserSystemGuardEnabled && process.platform === 'linux';
  }

  private getBrowserGlobalLockFilePath(): string {
    return join(tmpdir(), 'lawcast-browser-launch.lock');
  }

  private async acquireBrowserSlot(label: string): Promise<void> {
    const waitStartedAt = Date.now();
    let warned = false;

    for (;;) {
      const limit = this.browserConcurrencyLimit;
      if (this.activeBrowserSessions < limit) {
        this.activeBrowserSessions++;

        const waitedMs = Date.now() - waitStartedAt;
        if (waitedMs >= 1000) {
          LoggerUtils.debugDev(
            BrowserLaunchGuardService.name,
            `${label}: acquired browser slot after waiting ${waitedMs}ms (active=${this.activeBrowserSessions}/${limit})`,
          );
        }
        return;
      }

      if (!warned && Date.now() - waitStartedAt >= 5000) {
        warned = true;
        this.logger.warn(
          `${label}: waiting for browser slot >5s (active=${this.activeBrowserSessions}/${limit}, queue=${this.browserWaitQueue.length})`,
        );
      }

      await new Promise<void>((resolve) => {
        this.browserWaitQueue.push(resolve);
      });
    }
  }

  private releaseBrowserSlot(): void {
    this.activeBrowserSessions = Math.max(0, this.activeBrowserSessions - 1);
    const next = this.browserWaitQueue.shift();
    if (next) next();
  }

  private isBrowserLaunchResourceError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const message = error.message.toLowerCase();
    return (
      message.includes('failed to launch the browser process') ||
      message.includes('resource temporarily unavailable') ||
      message.includes('posix_spawn') ||
      message.includes('chrome_crashpad_handler') ||
      message.includes('eagain')
    );
  }

  private async throttleBrowserLaunch(label: string): Promise<void> {
    const minIntervalMs = this.browserMinLaunchIntervalMs;
    if (minIntervalMs <= 0) {
      this.lastBrowserLaunchStartedAt = Date.now();
      return;
    }

    const gate = async () => {
      const elapsed = Date.now() - this.lastBrowserLaunchStartedAt;
      if (elapsed < minIntervalMs) {
        const waitMs = minIntervalMs - elapsed;
        LoggerUtils.debugDev(
          BrowserLaunchGuardService.name,
          `${label}: throttling Chromium launch by ${waitMs}ms`,
        );
        await delayMs(waitMs);
      }
      this.lastBrowserLaunchStartedAt = Date.now();
    };

    const next = this.browserLaunchThrottle.then(gate, gate);
    this.browserLaunchThrottle = next.catch(() => undefined);
    await next;
  }

  private async waitForResourceCooldownIfNeeded(label: string): Promise<void> {
    const now = Date.now();
    if (this.resourceCooldownUntil <= now) {
      return;
    }

    const waitMs = this.resourceCooldownUntil - now;
    this.logger.warn(
      `${label}: waiting ${waitMs}ms due to recent Chromium resource pressure`,
    );
    await delayMs(waitMs);
  }

  private async readFileTrimmed(path: string): Promise<string | null> {
    try {
      return (await fs.readFile(path, 'utf8')).trim();
    } catch {
      return null;
    }
  }

  private parseNumberOrNull(value: string | null): number | null {
    if (!value) return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return null;
    }
    return parsed;
  }

  private async readPidsSnapshot(): Promise<{
    current: number | null;
    max: number | null;
    usagePercent: number | null;
  }> {
    const currentCandidates = [
      '/sys/fs/cgroup/pids.current',
      '/sys/fs/cgroup/pids/pids.current',
    ];
    const maxCandidates = [
      '/sys/fs/cgroup/pids.max',
      '/sys/fs/cgroup/pids/pids.max',
    ];

    let current: number | null = null;
    for (const path of currentCandidates) {
      current = this.parseNumberOrNull(await this.readFileTrimmed(path));
      if (current != null) break;
    }

    let max: number | null = null;
    for (const path of maxCandidates) {
      const raw = await this.readFileTrimmed(path);
      if (!raw || raw === 'max') continue;
      max = this.parseNumberOrNull(raw);
      if (max != null) break;
    }

    if (current == null || max == null || max <= 0) {
      return { current, max, usagePercent: null };
    }

    return {
      current,
      max,
      usagePercent: (current / max) * 100,
    };
  }

  private async readMemAvailableFromMemInfoMb(): Promise<number | null> {
    const memInfo = await this.readFileTrimmed('/proc/meminfo');
    if (!memInfo) return null;

    const match = memInfo.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
    if (!match?.[1]) return null;

    const availableKb = Number(match[1]);
    if (!Number.isFinite(availableKb) || availableKb < 0) return null;
    return Math.floor(availableKb / 1024);
  }

  private async readCgroupMemAvailableMb(): Promise<number | null> {
    const currentCandidates = [
      '/sys/fs/cgroup/memory.current',
      '/sys/fs/cgroup/memory/memory.usage_in_bytes',
    ];
    const maxCandidates = [
      '/sys/fs/cgroup/memory.max',
      '/sys/fs/cgroup/memory/memory.limit_in_bytes',
    ];

    let current: number | null = null;
    for (const path of currentCandidates) {
      current = this.parseNumberOrNull(await this.readFileTrimmed(path));
      if (current != null) break;
    }

    let max: number | null = null;
    for (const path of maxCandidates) {
      const raw = await this.readFileTrimmed(path);
      if (!raw || raw === 'max') continue;
      max = this.parseNumberOrNull(raw);
      if (max != null) break;
    }

    if (current == null || max == null || max <= current) {
      return null;
    }

    return Math.floor((max - current) / (1024 * 1024));
  }

  private async readSystemPressureSnapshot(): Promise<{
    pidsCurrent: number | null;
    pidsMax: number | null;
    pidsUsagePercent: number | null;
    memAvailableMb: number | null;
  }> {
    if (!this.isSystemGuardActiveOnCurrentPlatform()) {
      return {
        pidsCurrent: null,
        pidsMax: null,
        pidsUsagePercent: null,
        memAvailableMb: null,
      };
    }

    const pids = await this.readPidsSnapshot();
    const cgroupMemAvailableMb = await this.readCgroupMemAvailableMb();
    const memInfoAvailableMb = await this.readMemAvailableFromMemInfoMb();

    return {
      pidsCurrent: pids.current,
      pidsMax: pids.max,
      pidsUsagePercent: pids.usagePercent,
      memAvailableMb: cgroupMemAvailableMb ?? memInfoAvailableMb,
    };
  }

  private async waitForSystemPressureToRecover(label: string): Promise<void> {
    if (!this.isSystemGuardActiveOnCurrentPlatform()) {
      return;
    }

    const startedAt = Date.now();
    let warnedAt = 0;

    for (;;) {
      const snapshot = await this.readSystemPressureSnapshot();
      const reasons: string[] = [];

      if (
        snapshot.pidsUsagePercent != null &&
        snapshot.pidsUsagePercent >= this.browserSystemGuardMaxPidsUsagePercent
      ) {
        reasons.push(
          `pid usage ${snapshot.pidsUsagePercent.toFixed(1)}% >= ${this.browserSystemGuardMaxPidsUsagePercent}%`,
        );
      }

      if (
        snapshot.memAvailableMb != null &&
        snapshot.memAvailableMb < this.browserSystemGuardMinMemAvailableMb
      ) {
        reasons.push(
          `mem available ${snapshot.memAvailableMb}MiB < ${this.browserSystemGuardMinMemAvailableMb}MiB`,
        );
      }

      if (reasons.length === 0) {
        return;
      }

      const waitedMs = Date.now() - startedAt;
      if (warnedAt === 0 || Date.now() - warnedAt >= 5000) {
        warnedAt = Date.now();
        this.logger.warn(
          `${label}: delaying Chromium launch due to system pressure (${reasons.join(', ')})`,
        );
      }

      if (waitedMs >= this.browserSystemGuardWaitTimeoutMs) {
        const pressureError = new Error(
          `${label}: system guard timeout after ${this.browserSystemGuardWaitTimeoutMs}ms (${reasons.join(', ')})`,
        );
        (pressureError as Error & { cause?: unknown }).cause = {
          waitedMs,
          snapshot,
          thresholds: {
            maxPidsUsagePercent: this.browserSystemGuardMaxPidsUsagePercent,
            minMemAvailableMb: this.browserSystemGuardMinMemAvailableMb,
          },
        };
        throw pressureError;
      }

      await delayMs(this.browserSystemGuardCheckIntervalMs);
    }
  }

  private async acquireGlobalBrowserLock(
    label: string,
  ): Promise<(() => Promise<void>) | null> {
    if (!this.browserGlobalLockEnabled) {
      return null;
    }

    const lockFilePath = this.getBrowserGlobalLockFilePath();
    const waitTimeoutMs = this.browserGlobalLockWaitTimeoutMs;
    const staleMs = this.browserGlobalLockStaleMs;
    const waitStartedAt = Date.now();
    let warned = false;

    for (;;) {
      try {
        const handle = await fs.open(lockFilePath, 'wx');
        await handle.writeFile(
          JSON.stringify({
            pid: process.pid,
            label,
            acquiredAt: new Date().toISOString(),
          }),
          'utf8',
        );

        const release = async () => {
          try {
            await handle.close();
          } catch {
            // ignore close failures on release path
          }

          try {
            await fs.unlink(lockFilePath);
          } catch {
            // lock may already be removed by external cleanup
          }
        };

        const waitedMs = Date.now() - waitStartedAt;
        if (waitedMs >= 1000) {
          LoggerUtils.debugDev(
            BrowserLaunchGuardService.name,
            `${label}: acquired global browser lock after ${waitedMs}ms`,
          );
        }

        return release;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code !== 'EEXIST') {
          throw error;
        }

        try {
          const stat = await fs.stat(lockFilePath);
          const ageMs = Date.now() - stat.mtimeMs;
          if (ageMs > staleMs) {
            this.logger.warn(
              `${label}: removing stale global browser lock (age=${Math.round(ageMs)}ms)`,
            );
            await fs.unlink(lockFilePath).catch(() => undefined);
            continue;
          }
        } catch {
          // race: file disappeared between open/stat
          continue;
        }

        const waitedMs = Date.now() - waitStartedAt;
        if (!warned && waitedMs >= 5000) {
          warned = true;
          this.logger.warn(
            `${label}: waiting for global browser lock >5s (${waitedMs}ms)`,
          );
        }

        if (waitedMs >= waitTimeoutMs) {
          const timeoutError = new Error(
            `${label}: timed out waiting for global browser lock (${waitTimeoutMs}ms)`,
          );
          (timeoutError as Error & { cause?: unknown }).cause = {
            lockFilePath,
            waitTimeoutMs,
          };
          throw timeoutError;
        }

        await delayMs(150);
      }
    }
  }

  async getDebugState(): Promise<{
    activeBrowserSessions: number;
    queuedWaiters: number;
    configured: {
      maxConcurrency: number;
      launchRetryCount: number;
      launchRetryDelayMs: number;
      minLaunchIntervalMs: number;
      globalLockEnabled: boolean;
      globalLockWaitTimeoutMs: number;
      globalLockStaleMs: number;
      resourceCooldownMs: number;
      globalLockFilePath: string;
      systemGuardEnabled: boolean;
      systemGuardEnabledForCurrentPlatform: boolean;
      systemGuardWaitTimeoutMs: number;
      systemGuardCheckIntervalMs: number;
      systemGuardMaxPidsUsagePercent: number;
      systemGuardMinMemAvailableMb: number;
    };
    runtime: {
      lastBrowserLaunchStartedAt: string | null;
      resourceCooldownRemainingMs: number;
    };
    globalLock: {
      exists: boolean;
      ageMs: number | null;
      owner: string | null;
    };
    systemPressure: {
      pidsCurrent: number | null;
      pidsMax: number | null;
      pidsUsagePercent: number | null;
      memAvailableMb: number | null;
    };
  }> {
    const lockFilePath = this.getBrowserGlobalLockFilePath();
    let globalLockExists = false;
    let globalLockAgeMs: number | null = null;
    let globalLockOwner: string | null = null;

    try {
      const [stat, ownerRaw] = await Promise.all([
        fs.stat(lockFilePath),
        fs.readFile(lockFilePath, 'utf8').catch(() => ''),
      ]);
      globalLockExists = true;
      globalLockAgeMs = Math.max(0, Math.round(Date.now() - stat.mtimeMs));

      if (ownerRaw) {
        try {
          const parsed = JSON.parse(ownerRaw) as {
            pid?: number;
            label?: string;
            acquiredAt?: string;
          };
          const pidPart =
            typeof parsed.pid === 'number' ? `pid=${parsed.pid}` : null;
          const labelPart = parsed.label ? `label=${parsed.label}` : null;
          const tsPart = parsed.acquiredAt ? `at=${parsed.acquiredAt}` : null;
          globalLockOwner = [pidPart, labelPart, tsPart]
            .filter((v): v is string => Boolean(v))
            .join(' ');
          if (!globalLockOwner) {
            globalLockOwner = ownerRaw.slice(0, 180);
          }
        } catch {
          globalLockOwner = ownerRaw.slice(0, 180);
        }
      }
    } catch {
      // missing lock file is a valid state
    }

    return {
      activeBrowserSessions: this.activeBrowserSessions,
      queuedWaiters: this.browserWaitQueue.length,
      configured: {
        maxConcurrency: this.browserConcurrencyLimit,
        launchRetryCount: this.browserLaunchRetryCount,
        launchRetryDelayMs: this.browserLaunchRetryDelayMs,
        minLaunchIntervalMs: this.browserMinLaunchIntervalMs,
        globalLockEnabled: this.browserGlobalLockEnabled,
        globalLockWaitTimeoutMs: this.browserGlobalLockWaitTimeoutMs,
        globalLockStaleMs: this.browserGlobalLockStaleMs,
        resourceCooldownMs: this.browserResourceCooldownMs,
        globalLockFilePath: lockFilePath,
        systemGuardEnabled: this.browserSystemGuardEnabled,
        systemGuardEnabledForCurrentPlatform:
          this.isSystemGuardActiveOnCurrentPlatform(),
        systemGuardWaitTimeoutMs: this.browserSystemGuardWaitTimeoutMs,
        systemGuardCheckIntervalMs: this.browserSystemGuardCheckIntervalMs,
        systemGuardMaxPidsUsagePercent:
          this.browserSystemGuardMaxPidsUsagePercent,
        systemGuardMinMemAvailableMb: this.browserSystemGuardMinMemAvailableMb,
      },
      runtime: {
        lastBrowserLaunchStartedAt:
          this.lastBrowserLaunchStartedAt > 0
            ? new Date(this.lastBrowserLaunchStartedAt).toISOString()
            : null,
        resourceCooldownRemainingMs: Math.max(
          0,
          this.resourceCooldownUntil - Date.now(),
        ),
      },
      globalLock: {
        exists: globalLockExists,
        ageMs: globalLockAgeMs,
        owner: globalLockOwner,
      },
      systemPressure: await this.readSystemPressureSnapshot(),
    };
  }

  async runWithGuard<T>(label: string, task: () => Promise<T>): Promise<T> {
    await this.acquireBrowserSlot(label);
    let releaseGlobalLock: (() => Promise<void>) | null = null;
    try {
      releaseGlobalLock = await this.acquireGlobalBrowserLock(label);
      const retries = this.browserLaunchRetryCount;
      const baseDelayMs = this.browserLaunchRetryDelayMs;

      for (let attempt = 0; ; attempt++) {
        try {
          await this.waitForResourceCooldownIfNeeded(label);
          await this.waitForSystemPressureToRecover(label);
          await this.throttleBrowserLaunch(label);
          return await task();
        } catch (error) {
          const isResourceError = this.isBrowserLaunchResourceError(error);
          if (isResourceError) {
            const cooldownMs = this.browserResourceCooldownMs;
            this.resourceCooldownUntil = Math.max(
              this.resourceCooldownUntil,
              Date.now() + cooldownMs,
            );
          }

          const shouldRetry = isResourceError && attempt < retries;
          if (!shouldRetry) {
            throw error;
          }

          const waitMs = baseDelayMs * (attempt + 1);
          this.logger.warn(
            `${label}: browser launch resource pressure detected, retrying in ${waitMs}ms (${attempt + 1}/${retries})`,
          );
          await delayMs(waitMs);
        }
      }
    } finally {
      if (releaseGlobalLock) {
        await releaseGlobalLock();
      }
      this.releaseBrowserSlot();
    }
  }
}
