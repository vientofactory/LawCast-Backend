import { Injectable, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { WebhookCleanupService } from '../webhook/webhook-cleanup.service';
import { CrawlingService } from '../crawling/crawling.service';
import appConfig, { APP_CONSTANTS } from '../../config/app.config';
import { LoggerUtils } from '../../utils/logger.utils';
import { DiscordBridgeService } from '../discord-bridge/discord-bridge.service';
import { BridgeLogLevel } from '../discord-bridge/discord-bridge.types';
import { ArchiveSyncService } from '../crawling/archive-sync.service';
import { ChangeTrackingService } from '../change-tracking/change-tracking.service';

const CRON_TIMEZONE = appConfig().cron.timezone;

@Injectable()
export class CronJobsService {
  private readonly logger = LoggerUtils.getContextLogger(CronJobsService.name);

  constructor(
    private readonly webhookCleanupService: WebhookCleanupService,
    private readonly crawlingService: CrawlingService,
    private readonly archiveSyncService: ArchiveSyncService,
    private readonly changeTrackingService: ChangeTrackingService,
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

  private shouldSkipCrawlingCron(taskName: string): boolean {
    if (!this.archiveSyncService.isAnyPhaseRunning()) return false;

    const message = `${taskName} skipped - archive sync phase is currently running`;
    this.logger.warn(message);
    void this.discordBridge?.logEvent(
      BridgeLogLevel.WARN,
      CronJobsService.name,
      message,
    );
    return true;
  }

  private shouldSkipArchiveSyncCron(taskName: string): boolean {
    if (!this.crawlingService.isSchedulerBusy({ includeBackground: true })) {
      return false;
    }

    const message = `${taskName} skipped - crawling scheduler is busy`;
    this.logger.warn(message);
    void this.discordBridge?.logEvent(
      BridgeLogLevel.WARN,
      CronJobsService.name,
      message,
    );
    return true;
  }

  /**
   * Crawls for new legislative notices and dispatches notifications.
   * Also checks NsmLmSts for newly proposed (\"\ubc1c\uc758\") bills that have not yet
   * entered the formal \uc785\ubc95\uc608\uace0 process so the system can surface them earlier.
   */
  @Cron(APP_CONSTANTS.CRON.EXPRESSIONS.CRAWLING_CHECK, {
    timeZone: CRON_TIMEZONE,
  })
  async handleCrawlingCheck(): Promise<void> {
    if (this.shouldSkipCrawlingCron('crawling and notification')) {
      return;
    }
    await this.execute('crawling and notification', () =>
      this.crawlingService.handleCron(),
    );
  }

  /**
   * Crawls NsmLmSts pending ("발의") bills on a slower cadence to reduce
   * upstream connection resets while keeping early detection coverage.
   */
  @Cron(APP_CONSTANTS.CRON.EXPRESSIONS.PENDING_CRAWLING_CHECK, {
    timeZone: CRON_TIMEZONE,
  })
  async handlePendingCrawlingCheck(): Promise<void> {
    if (this.shouldSkipCrawlingCron('pending bills crawl (NsmLmSts)')) {
      return;
    }
    await this.execute('pending bills crawl (NsmLmSts)', () =>
      this.crawlingService.handlePendingCron(),
    );
  }

  /**
   * Drains proposalReason retry queue on a dedicated schedule.
   * Uses append-only repair path (strict immutable snapshot policy).
   */
  @Cron(APP_CONSTANTS.CRON.EXPRESSIONS.PROPOSAL_REASON_BACKFILL_DRAIN, {
    timeZone: CRON_TIMEZONE,
  })
  async handleProposalReasonBackfillDrain(): Promise<void> {
    await this.execute('proposalReason backfill drain', () =>
      this.crawlingService.handleProposalReasonBackfillCron(),
    );
  }

  /**
   * Syncs isDone flags for expired legislative notices every 6 hours
   */
  @Cron(APP_CONSTANTS.CRON.EXPRESSIONS.IS_DONE_SYNC, {
    timeZone: CRON_TIMEZONE,
  })
  async handleIsDoneSync(): Promise<void> {
    if (this.shouldSkipArchiveSyncCron('isDone sync')) {
      return;
    }
    await this.execute('isDone sync', () =>
      this.archiveSyncService.runIsDoneSync('cron').then(() => {}),
    );
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
   * Re-validates the SHA-256 integrity of every archive record once a day.
   * Forces `integrityVerifiedAt` to be refreshed on all verifiable rows so
   * operators can confirm recency of the last check.
   */
  @Cron(APP_CONSTANTS.CRON.EXPRESSIONS.INTEGRITY_RESCAN, {
    timeZone: CRON_TIMEZONE,
  })
  async handleIntegrityRescan(): Promise<void> {
    if (this.shouldSkipArchiveSyncCron('integrity re-scan')) {
      return;
    }
    await this.execute('integrity re-scan', () =>
      this.archiveSyncService
        .runScheduledIntegrityRescan('cron')
        .then(() => {}),
    );
  }

  @Cron(APP_CONSTANTS.CRON.EXPRESSIONS.CHANGE_TRACKING_DAILY_AUDIT, {
    timeZone: CRON_TIMEZONE,
  })
  async handleChangeTrackingDailyAudit(): Promise<void> {
    if (this.shouldSkipArchiveSyncCron('change-tracking daily audit')) {
      return;
    }
    await this.execute('change-tracking daily audit', () =>
      this.changeTrackingService.runScheduledChainAudit('daily').then(() => {}),
    );
  }

  @Cron(APP_CONSTANTS.CRON.EXPRESSIONS.CHANGE_TRACKING_WEEKLY_AUDIT, {
    timeZone: CRON_TIMEZONE,
  })
  async handleChangeTrackingWeeklyAudit(): Promise<void> {
    if (this.shouldSkipArchiveSyncCron('change-tracking weekly audit')) {
      return;
    }
    await this.execute('change-tracking weekly audit', () =>
      this.changeTrackingService
        .runScheduledChainAudit('weekly')
        .then(() => {}),
    );
  }

  @Cron(APP_CONSTANTS.CRON.EXPRESSIONS.QUICK_KEYWORDS_REFRESH, {
    timeZone: CRON_TIMEZONE,
  })
  async handleQuickKeywordRefresh(): Promise<void> {
    await this.execute('quick keyword refresh', () =>
      this.crawlingService.refreshQuickKeywordSuggestions().then(() => {}),
    );
  }
}
