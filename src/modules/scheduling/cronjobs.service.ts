import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { WebhookCleanupService } from '../webhook/webhook-cleanup.service';
import { CrawlingService } from '../crawling/crawling.service';
import appConfig, { APP_CONSTANTS } from '../../config/app.config';
import { LoggerUtils } from '../../utils/logger.utils';
import { DiscordBridgeService } from '../discord-bridge/discord-bridge.service';
import { BridgeLogLevel } from '../discord-bridge/discord-bridge.types';
import { ArchiveSyncService } from '../crawling/archive-sync.service';
import { ArchiveOrchestratorService } from '../crawling/archive-orchestrator.service';

const CRON_TIMEZONE = appConfig().cron.timezone;

@Injectable()
export class CronJobsService {
  private readonly logger = new Logger(CronJobsService.name);

  constructor(
    private readonly webhookCleanupService: WebhookCleanupService,
    private readonly crawlingService: CrawlingService,
    private readonly archiveSyncService: ArchiveSyncService,
    private readonly archiveOrchestratorService: ArchiveOrchestratorService,
    @Optional() private readonly discordBridge: DiscordBridgeService,
  ) {}

  /**
   * Wraps the execution of a scheduled task with standardized logging and error handling.
   * @param taskName A descriptive name of the task for logging purposes.
   * @param task An asynchronous function that performs the actual work of the scheduled task.
   */
  private async execute(
    taskName: string,
    task: () => Promise<void>,
  ): Promise<void> {
    void this.discordBridge?.logEvent(
      BridgeLogLevel.DEBUG,
      CronJobsService.name,
      `Scheduled task started: **${taskName}**`,
    );
    try {
      LoggerUtils.debugDev(
        CronJobsService.name,
        `Starting scheduled ${taskName}...`,
      );
      await task();
      void this.discordBridge?.logEvent(
        BridgeLogLevel.DEBUG,
        CronJobsService.name,
        `Scheduled task completed: **${taskName}**`,
      );
      LoggerUtils.debugDev(
        CronJobsService.name,
        `Completed scheduled ${taskName}.`,
      );
    } catch (error) {
      this.logger.error(`Scheduled ${taskName} failed:`, error);
      void this.discordBridge?.logEvent(
        BridgeLogLevel.ERROR,
        CronJobsService.name,
        `Scheduled task failed: **${taskName}** - ${(error as Error).message}`,
      );
    }
  }

  /**
   * Runs webhook cleanup daily at midnight
   */
  @Cron(APP_CONSTANTS.CRON.EXPRESSIONS.WEBHOOK_CLEANUP, {
    timeZone: CRON_TIMEZONE,
  })
  async handleWebhookCleanup(): Promise<void> {
    await this.execute('webhook cleanup', () =>
      this.webhookCleanupService.intelligentWebhookCleanup(),
    );
  }

  /**
   * Runs deep system optimization daily at 2 AM
   */
  @Cron(APP_CONSTANTS.CRON.EXPRESSIONS.WEBHOOK_OPTIMIZATION, {
    timeZone: CRON_TIMEZONE,
  })
  async handleWebhookOptimization(): Promise<void> {
    await this.execute('webhook optimization', () =>
      this.webhookCleanupService.runSystemOptimization(),
    );
  }

  /**
   * Runs real-time system monitoring and self-healing every hour
   */
  @Cron(APP_CONSTANTS.CRON.EXPRESSIONS.SYSTEM_MONITORING, {
    timeZone: CRON_TIMEZONE,
  })
  async handleSystemMonitoring(): Promise<void> {
    await this.execute('system monitoring', () =>
      this.webhookCleanupService.realTimeSystemMonitoring(),
    );
  }

  /**
   * Crawls for new legislative notices and dispatches notifications
   */
  @Cron(APP_CONSTANTS.CRON.EXPRESSIONS.CRAWLING_CHECK, {
    timeZone: CRON_TIMEZONE,
  })
  async handleCrawlingCheck(): Promise<void> {
    await this.execute('crawling and notification', () =>
      this.crawlingService.handleCron(),
    );
  }

  /**
   * Syncs isDone flags for expired legislative notices every 6 hours
   */
  @Cron(APP_CONSTANTS.CRON.EXPRESSIONS.IS_DONE_SYNC, {
    timeZone: CRON_TIMEZONE,
  })
  async handleIsDoneSync(): Promise<void> {
    await this.execute('isDone sync', () =>
      this.archiveSyncService.runIsDoneSync('cron').then(() => undefined),
    );
  }

  /**
   * Re-validates the SHA-256 integrity of every archive record once a day.
   * Forces `integrityVerifiedAt` to be refreshed on all verifiable rows so
   * operators can confirm recency of the last check.
   */
  @Cron(APP_CONSTANTS.CRON.EXPRESSIONS.INTEGRITY_RESCAN, {
    timeZone: CRON_TIMEZONE,
  })
  async handleIntegrityRescan(): Promise<void> {
    await this.execute('integrity re-scan', () =>
      this.archiveSyncService
        .runScheduledIntegrityRescan('cron')
        .then(() => undefined),
    );
  }

  /**
   * Periodically re-triggers the screenshot backfill so notices that were
   * permanently skipped in a previous session are retried without a full
   * server restart. Skipped when a capture is already in progress or the
   * queue still has pending items.
   */
  @Cron(APP_CONSTANTS.CRON.EXPRESSIONS.SCREENSHOT_BACKFILL, {
    timeZone: CRON_TIMEZONE,
  })
  async handleScreenshotBackfill(): Promise<void> {
    await this.execute('screenshot backfill', () =>
      this.archiveOrchestratorService.handleScreenshotBackfill(),
    );
  }
}
