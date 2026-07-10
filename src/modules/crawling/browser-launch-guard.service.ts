import { Injectable } from '@nestjs/common';
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

  async runWithGuard<T>(label: string, task: () => Promise<T>): Promise<T> {
    await this.acquireBrowserSlot(label);
    try {
      const retries = this.getBrowserLaunchRetryCount();
      const baseDelayMs = this.getBrowserLaunchRetryDelayMs();

      for (let attempt = 0; ; attempt++) {
        try {
          await this.throttleBrowserLaunch(label);
          return await task();
        } catch (error) {
          const shouldRetry =
            this.isBrowserLaunchResourceError(error) && attempt < retries;
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
      this.releaseBrowserSlot();
    }
  }
}
