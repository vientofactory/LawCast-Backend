import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { WebhookCleanupService } from '../services/webhook-cleanup.service';
import { CrawlingService } from '../services/crawling.service';
import appConfig, { APP_CONSTANTS } from '../config/app.config';
import { LoggerUtils } from '../utils/logger.utils';
import { DiscordBridgeService } from '../modules/discord-bridge/discord-bridge.service';
import { BridgeLogLevel } from '../modules/discord-bridge/discord-bridge.types';

const CRON_TIMEZONE = appConfig().cron.timezone;

@Injectable()
export class CronJobsService {
  private readonly logger = new Logger(CronJobsService.name);

  constructor(
    private readonly webhookCleanupService: WebhookCleanupService,
    private readonly crawlingService: CrawlingService,
    @Optional() private readonly discordBridge: DiscordBridgeService,
  ) {}

  /**
   * 로깅을 위한 공통 실행 래퍼
   */
  private async execute(
    taskName: string,
    task: () => Promise<void>,
  ): Promise<void> {
    void this.discordBridge.logEvent(
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
      void this.discordBridge.logEvent(
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
      void this.discordBridge.logEvent(
        BridgeLogLevel.ERROR,
        CronJobsService.name,
        `Scheduled task failed: **${taskName}** — ${(error as Error).message}`,
      );
    }
  }

  /**
   * 매일 자정에 웹훅 정리 수행
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
   * 매일 새벽 2시에 심층 시스템 최적화 수행
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
   * 매시간 실시간 시스템 모니터링 및 자가 치유
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
   * 새로운 입법예고 크롤링 및 알림 전송
   */
  @Cron(APP_CONSTANTS.CRON.EXPRESSIONS.CRAWLING_CHECK, {
    timeZone: CRON_TIMEZONE,
  })
  async handleCrawlingCheck(): Promise<void> {
    await this.execute('crawling and notification', () =>
      this.crawlingService.handleCron(),
    );
  }
}
