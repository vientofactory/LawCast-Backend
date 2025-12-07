import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { WebhookCleanupService } from '../services/webhook-cleanup.service';
import { CrawlingService } from '../services/crawling.service';
import { APP_CONSTANTS } from '../config/app.config';
import { LoggerUtils } from '../utils/logger.utils';

@Injectable()
export class CronJobsService {
  private readonly logger = new Logger(CronJobsService.name);

  constructor(
    private readonly webhookCleanupService: WebhookCleanupService,
    private readonly crawlingService: CrawlingService,
  ) {}

  /**
   * 로깅을 위한 공통 실행 래퍼
   */
  private async execute(
    taskName: string,
    task: () => Promise<void>,
  ): Promise<void> {
    try {
      LoggerUtils.debugDev(
        CronJobsService.name,
        `Starting scheduled ${taskName}...`,
      );
      await task();
      LoggerUtils.debugDev(
        CronJobsService.name,
        `Completed scheduled ${taskName}.`,
      );
    } catch (error) {
      this.logger.error(`Scheduled ${taskName} failed:`, error);
    }
  }

  /**
   * 매일 자정에 웹훅 정리 수행
   */
  @Cron(APP_CONSTANTS.CRON.EXPRESSIONS.WEBHOOK_CLEANUP)
  async handleWebhookCleanup(): Promise<void> {
    await this.execute('webhook cleanup', () =>
      this.webhookCleanupService.intelligentWebhookCleanup(),
    );
  }

  /**
   * 매일 새벽 2시에 심층 시스템 최적화 수행
   */
  @Cron(APP_CONSTANTS.CRON.EXPRESSIONS.WEBHOOK_OPTIMIZATION)
  async handleWebhookOptimization(): Promise<void> {
    await this.execute('webhook optimization', () =>
      this.webhookCleanupService.runSystemOptimization(),
    );
  }

  /**
   * 매시간 실시간 시스템 모니터링 및 자가 치유
   */
  @Cron(APP_CONSTANTS.CRON.EXPRESSIONS.SYSTEM_MONITORING)
  async handleSystemMonitoring(): Promise<void> {
    await this.execute('system monitoring', () =>
      this.webhookCleanupService.realTimeSystemMonitoring(),
    );
  }

  /**
   * 10분마다 새로운 입법예고 크롤링 및 알림 전송
   */
  @Cron(APP_CONSTANTS.CRON.EXPRESSIONS.CRAWLING_CHECK)
  async handleCrawlingCheck(): Promise<void> {
    await this.execute('crawling and notification', () =>
      this.crawlingService.handleCron(),
    );
  }
}
