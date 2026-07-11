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

  private activeBrowserSessions = 0;
  private readonly browserWaitQueue: Array<() => void> = [];
  private lastBrowserLaunchStartedAt = 0;
  private browserLaunchThrottle: Promise<void> = Promise.resolve();
  private resourceCooldownUntil = 0;

  private resolvePositiveInt(value: string | undefined): number | null {
    if (!value) return null;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return null;
    }
    return parsed;
  }

  private getBrowserConcurrencyLimit(): number {
    return (
      this.resolvePositiveInt(process.env.CRAWLING_BROWSER_MAX_CONCURRENCY) ??
      APP_CONSTANTS.CRAWLING.BROWSER_MAX_CONCURRENCY
    );
  }

  private getBrowserLaunchRetryCount(): number {
    return (
      this.resolvePositiveInt(
        process.env.CRAWLING_BROWSER_LAUNCH_RETRY_COUNT,
      ) ?? APP_CONSTANTS.CRAWLING.BROWSER_LAUNCH_RETRY_COUNT
    );
  }

  private getBrowserLaunchRetryDelayMs(): number {
    return (
      this.resolvePositiveInt(
        process.env.CRAWLING_BROWSER_LAUNCH_RETRY_DELAY_MS,
      ) ?? APP_CONSTANTS.CRAWLING.BROWSER_LAUNCH_RETRY_DELAY_MS
    );
  }

  private getBrowserMinLaunchIntervalMs(): number {
    return (
      this.resolvePositiveInt(
        process.env.CRAWLING_BROWSER_MIN_LAUNCH_INTERVAL_MS,
      ) ?? APP_CONSTANTS.CRAWLING.BROWSER_MIN_LAUNCH_INTERVAL_MS
    );
  }

  private getBrowserGlobalLockEnabled(): boolean {
    const raw = process.env.CRAWLING_BROWSER_GLOBAL_LOCK_ENABLED;
    if (!raw) return APP_CONSTANTS.CRAWLING.BROWSER_GLOBAL_LOCK_ENABLED;

    const normalized = raw.trim().toLowerCase();
    if (['0', 'false', 'off', 'no'].includes(normalized)) return false;
    if (['1', 'true', 'on', 'yes'].includes(normalized)) return true;
    return APP_CONSTANTS.CRAWLING.BROWSER_GLOBAL_LOCK_ENABLED;
  }

  private getBrowserGlobalLockWaitTimeoutMs(): number {
    return (
      this.resolvePositiveInt(
        process.env.CRAWLING_BROWSER_GLOBAL_LOCK_WAIT_TIMEOUT_MS,
      ) ?? APP_CONSTANTS.CRAWLING.BROWSER_GLOBAL_LOCK_WAIT_TIMEOUT_MS
    );
  }

  private getBrowserGlobalLockStaleMs(): number {
    return (
      this.resolvePositiveInt(
        process.env.CRAWLING_BROWSER_GLOBAL_LOCK_STALE_MS,
      ) ?? APP_CONSTANTS.CRAWLING.BROWSER_GLOBAL_LOCK_STALE_MS
    );
  }

  private getBrowserResourceCooldownMs(): number {
    return (
      this.resolvePositiveInt(
        process.env.CRAWLING_BROWSER_RESOURCE_COOLDOWN_MS,
      ) ?? APP_CONSTANTS.CRAWLING.BROWSER_RESOURCE_COOLDOWN_MS
    );
  }

  private getBrowserGlobalLockFilePath(): string {
    const fromEnv = process.env.CRAWLING_BROWSER_GLOBAL_LOCK_FILE_PATH?.trim();
    if (fromEnv) return fromEnv;
    return join(tmpdir(), 'lawcast-browser-launch.lock');
  }

  private async acquireBrowserSlot(label: string): Promise<void> {
    const waitStartedAt = Date.now();
    let warned = false;

    for (;;) {
      const limit = this.getBrowserConcurrencyLimit();
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
    const minIntervalMs = this.getBrowserMinLaunchIntervalMs();
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

  private async acquireGlobalBrowserLock(
    label: string,
  ): Promise<(() => Promise<void>) | null> {
    if (!this.getBrowserGlobalLockEnabled()) {
      return null;
    }

    const lockFilePath = this.getBrowserGlobalLockFilePath();
    const waitTimeoutMs = this.getBrowserGlobalLockWaitTimeoutMs();
    const staleMs = this.getBrowserGlobalLockStaleMs();
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
        maxConcurrency: this.getBrowserConcurrencyLimit(),
        launchRetryCount: this.getBrowserLaunchRetryCount(),
        launchRetryDelayMs: this.getBrowserLaunchRetryDelayMs(),
        minLaunchIntervalMs: this.getBrowserMinLaunchIntervalMs(),
        globalLockEnabled: this.getBrowserGlobalLockEnabled(),
        globalLockWaitTimeoutMs: this.getBrowserGlobalLockWaitTimeoutMs(),
        globalLockStaleMs: this.getBrowserGlobalLockStaleMs(),
        resourceCooldownMs: this.getBrowserResourceCooldownMs(),
        globalLockFilePath: lockFilePath,
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
    };
  }

  async runWithGuard<T>(label: string, task: () => Promise<T>): Promise<T> {
    await this.acquireBrowserSlot(label);
    let releaseGlobalLock: (() => Promise<void>) | null = null;
    try {
      releaseGlobalLock = await this.acquireGlobalBrowserLock(label);
      const retries = this.getBrowserLaunchRetryCount();
      const baseDelayMs = this.getBrowserLaunchRetryDelayMs();

      for (let attempt = 0; ; attempt++) {
        try {
          await this.waitForResourceCooldownIfNeeded(label);
          await this.throttleBrowserLaunch(label);
          return await task();
        } catch (error) {
          const isResourceError = this.isBrowserLaunchResourceError(error);
          if (isResourceError) {
            const cooldownMs = this.getBrowserResourceCooldownMs();
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
