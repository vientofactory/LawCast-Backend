import { Injectable, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { WebhookCleanupService } from '../webhook/webhook-cleanup.service';
import { CrawlingService } from '../crawling/crawling.service';
import appConfig, { APP_CONSTANTS } from '../../config/app.config';
import { LoggerUtils } from '../../utils/logger.utils';
import { DiscordBridgeService } from '../discord-bridge/discord-bridge.service';
import { ArchiveSyncService } from '../crawling/archive-sync.service';
import { ChangeTrackingService } from '../change-tracking/change-tracking.service';
import { logAndBridge } from '../../utils/bridge-log.utils';

const CRON_TIMEZONE = appConfig().cron.timezone;

@Injectable()
export class CronJobsService {
  private readonly logger = LoggerUtils.getContextLogger(CronJobsService.name);
  private readonly changeTrackingAuditQueue: Array<'daily' | 'weekly'> = [];
  private isDrainingChangeTrackingAuditQueue = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly webhookCleanupService: WebhookCleanupService,
    private readonly crawlingService: CrawlingService,
    private readonly archiveSyncService: ArchiveSyncService,
    private readonly changeTrackingService: ChangeTrackingService,
    @Optional() private readonly discordBridge: DiscordBridgeService,
  ) {}

  // Helper method to wrap cron job execution with logging and error handling

  /**
   * Wraps the execution of a scheduled task with standardized logging and error handling.
   * @param taskName A descriptive name of the task for logging purposes.
   * @param task An asynchronous function that performs the actual work of the scheduled task.
   */
  private async execute(
    taskName: string,
    task: () => Promise<void>,
  ): Promise<void> {
    logAndBridge({
      method: 'debugDev',
      message: `Starting scheduled ${taskName}...`,
      logger: this.logger,
      context: CronJobsService.name,
      discordBridge: this.discordBridge,
      bridgeMessage: `Scheduled task started: **${taskName}**`,
    });
    try {
      await task();
      logAndBridge({
        method: 'debugDev',
        message: `Completed scheduled ${taskName}.`,
        logger: this.logger,
        context: CronJobsService.name,
        discordBridge: this.discordBridge,
        bridgeMessage: `Scheduled task completed: **${taskName}**`,
      });
    } catch (error) {
      logAndBridge({
        method: 'error',
        message: `Scheduled ${taskName} failed:`,
        logger: this.logger,
        loggerArgs: [error],
        context: CronJobsService.name,
        discordBridge: this.discordBridge,
        bridgeMessage: `Scheduled task failed: **${taskName}** - ${(error as Error).message}`,
      });
    }
  }

  /**
   * Determines whether a crawling-related cron job should be skipped based on the current state of the archive sync service.
   * @param taskName A descriptive name of the task for logging purposes.
   * @returns A boolean indicating whether the cron job should be skipped.
   */
  private shouldSkipCrawlingCron(taskName: string): boolean {
    if (!this.archiveSyncService.isAnyPhaseRunning()) return false;

    const message = `${taskName} skipped - archive sync phase is currently running`;
    logAndBridge({
      method: 'warn',
      message,
      logger: this.logger,
      context: CronJobsService.name,
      discordBridge: this.discordBridge,
    });
    return true;
  }

  /**
   * Determines whether an archive sync-related cron job should be skipped based on the current state of the crawling service.
   * @param taskName A descriptive name of the task for logging purposes.
   * @returns A boolean indicating whether the cron job should be skipped.
   */
  private shouldSkipArchiveSyncCron(taskName: string): boolean {
    if (!this.crawlingService.isSchedulerBusy({ includeBackground: true })) {
      return false;
    }

    const message = `${taskName} skipped - crawling scheduler is busy`;
    logAndBridge({
      method: 'warn',
      message,
      logger: this.logger,
      context: CronJobsService.name,
      discordBridge: this.discordBridge,
    });
    return true;
  }

  /**
   * proposalReason backfill is browser-heavy and should not overlap with
   * archive sync phases or active crawling background workloads.
   */
  private shouldSkipProposalReasonBackfillCron(taskName: string): boolean {
    if (this.archiveSyncService.isAnyPhaseRunning()) {
      const message = `${taskName} skipped - archive sync phase is currently running`;
      logAndBridge({
        method: 'warn',
        message,
        logger: this.logger,
        context: CronJobsService.name,
        discordBridge: this.discordBridge,
      });
      return true;
    }

    if (!this.crawlingService.isSchedulerBusy({ includeBackground: true })) {
      return false;
    }

    const message = `${taskName} skipped - crawling scheduler is busy`;
    logAndBridge({
      method: 'warn',
      message,
      logger: this.logger,
      context: CronJobsService.name,
      discordBridge: this.discordBridge,
    });
    return true;
  }

  /**
   * Determines whether a database maintenance cron job should be skipped based on the current state of the archive sync and crawling services.
   * @param taskName A descriptive name of the task for logging purposes.
   * @returns A boolean indicating whether the cron job should be skipped.
   */
  private shouldSkipDatabaseMaintenanceCron(taskName: string): boolean {
    if (this.archiveSyncService.isAnyPhaseRunning()) {
      const message = `${taskName} skipped - archive sync phase is currently running`;
      logAndBridge({
        method: 'warn',
        message,
        logger: this.logger,
        context: CronJobsService.name,
        discordBridge: this.discordBridge,
      });
      return true;
    }

    if (!this.crawlingService.isSchedulerBusy({ includeBackground: true })) {
      return false;
    }

    const message = `${taskName} skipped - crawling scheduler is busy`;
    logAndBridge({
      method: 'warn',
      message,
      logger: this.logger,
      context: CronJobsService.name,
      discordBridge: this.discordBridge,
    });
    return true;
  }

  /**
   * Enqueues a change tracking audit task for the specified scope.
   * @param scope The scope of the audit ('daily' or 'weekly').
   * @returns A promise that resolves when the task has been enqueued.
   */
  private async enqueueChangeTrackingAudit(
    scope: 'daily' | 'weekly',
  ): Promise<void> {
    if (!this.changeTrackingAuditQueue.includes(scope)) {
      this.changeTrackingAuditQueue.push(scope);
    } else {
      LoggerUtils.debugDev(
        CronJobsService.name,
        `change-tracking ${scope} audit already queued; skipping duplicate enqueue`,
      );
    }

    if (this.isDrainingChangeTrackingAuditQueue) {
      return;
    }

    this.isDrainingChangeTrackingAuditQueue = true;
    try {
      while (this.changeTrackingAuditQueue.length > 0) {
        const nextScope = this.changeTrackingAuditQueue.shift();
        if (!nextScope) {
          continue;
        }

        const taskName = `change-tracking ${nextScope} audit`;

        // Chain audits are read-only verification jobs; run even when phase locks are busy.
        if (this.crawlingService.isSchedulerBusy({ includeBackground: true })) {
          const message =
            `${taskName} running despite crawling scheduler lock ` +
            '(critical scheduled audit)';
          logAndBridge({
            method: 'warn',
            message,
            logger: this.logger,
            context: CronJobsService.name,
            discordBridge: this.discordBridge,
          });
        }

        if (this.archiveSyncService.isAnyPhaseRunning()) {
          const message =
            `${taskName} running despite archive-sync phase lock ` +
            '(critical scheduled audit)';
          logAndBridge({
            method: 'warn',
            message,
            logger: this.logger,
            context: CronJobsService.name,
            discordBridge: this.discordBridge,
          });
        }

        await this.execute(taskName, () =>
          this.changeTrackingService
            .runScheduledChainAudit(nextScope)
            .then(() => {}),
        );
      }
    } finally {
      this.isDrainingChangeTrackingAuditQueue = false;
    }
  }

  // Cron job handlers

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
    if (
      this.shouldSkipProposalReasonBackfillCron('proposalReason backfill drain')
    ) {
      return;
    }

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
    await this.enqueueChangeTrackingAudit('daily');
  }

  @Cron(APP_CONSTANTS.CRON.EXPRESSIONS.CHANGE_TRACKING_WEEKLY_AUDIT, {
    timeZone: CRON_TIMEZONE,
  })
  async handleChangeTrackingWeeklyAudit(): Promise<void> {
    await this.enqueueChangeTrackingAudit('weekly');
  }

  @Cron(APP_CONSTANTS.CRON.EXPRESSIONS.QUICK_KEYWORDS_REFRESH, {
    timeZone: CRON_TIMEZONE,
  })
  async handleQuickKeywordRefresh(): Promise<void> {
    await this.execute('quick keyword refresh', () =>
      this.crawlingService.refreshQuickKeywordSuggestions().then(() => {}),
    );
  }

  /**
   * Compacts SQLite database pages to reclaim disk space.
   */
  @Cron(APP_CONSTANTS.CRON.EXPRESSIONS.SQLITE_VACUUM, {
    timeZone: CRON_TIMEZONE,
  })
  async handleSqliteVacuum(): Promise<void> {
    if (this.shouldSkipDatabaseMaintenanceCron('sqlite vacuum')) {
      return;
    }

    await this.execute('sqlite vacuum', async () => {
      const pageSizeResult = await this.dataSource.query('PRAGMA page_size;');
      const beforeFreeResult = await this.dataSource.query(
        'PRAGMA freelist_count;',
      );

      const pageSize = Number(pageSizeResult?.[0]?.page_size ?? 0);
      const beforeFreePages = Number(
        beforeFreeResult?.[0]?.freelist_count ?? 0,
      );
      const beforeEstimatedBytes = beforeFreePages * pageSize;

      await this.dataSource.query('VACUUM;');

      const afterFreeResult = await this.dataSource.query(
        'PRAGMA freelist_count;',
      );
      const afterFreePages = Number(afterFreeResult?.[0]?.freelist_count ?? 0);
      const reclaimedPages = Math.max(0, beforeFreePages - afterFreePages);
      const reclaimedBytes = reclaimedPages * pageSize;

      this.logger.log(
        `SQLite VACUUM completed (pageSize=${pageSize}, freePagesBefore=${beforeFreePages}, freePagesAfter=${afterFreePages}, reclaimedBytes≈${reclaimedBytes}, estimatedBytesBefore≈${beforeEstimatedBytes})`,
      );
      logAndBridge({
        method: 'log',
        message: `SQLite VACUUM completed (pageSize=${pageSize}, freePagesBefore=${beforeFreePages}, freePagesAfter=${afterFreePages}, reclaimedBytes≈${reclaimedBytes}, estimatedBytesBefore≈${beforeEstimatedBytes})`,
        logger: this.logger,
        context: CronJobsService.name,
        discordBridge: this.discordBridge,
      });
    });
  }
}
