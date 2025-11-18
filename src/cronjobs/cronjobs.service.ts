import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { WebhookCleanupService } from '../services/webhook-cleanup.service';
import { NotificationService } from '../services/notification.service';
import { APP_CONSTANTS } from '../config/app.config';

@Injectable()
export class CronJobsService {
  private readonly logger = new Logger(CronJobsService.name);

  constructor(
    private readonly webhookCleanupService: WebhookCleanupService,
    private readonly notificationService: NotificationService,
  ) {}

  /**
   * 매일 자정에 웹훅 정리 수행
   */
  @Cron(APP_CONSTANTS.CRON.EXPRESSIONS.WEBHOOK_CLEANUP)
  async handleWebhookCleanup(): Promise<void> {
    try {
      this.logger.log('Starting scheduled webhook cleanup...');
      await this.webhookCleanupService.intelligentWebhookCleanup();
    } catch (error) {
      this.logger.error('Scheduled webhook cleanup failed:', error);
    }
  }

  /**
   * 매일 새벽 2시에 심층 시스템 최적화 수행
   */
  @Cron(APP_CONSTANTS.CRON.EXPRESSIONS.WEBHOOK_OPTIMIZATION)
  async handleWebhookOptimization(): Promise<void> {
    try {
      this.logger.log('Starting scheduled webhook optimization...');
      await this.webhookCleanupService.weeklySystemOptimization();
    } catch (error) {
      this.logger.error('Scheduled webhook optimization failed:', error);
    }
  }

  /**
   * 매시간 실시간 시스템 모니터링 및 자가 치유
   */
  @Cron(APP_CONSTANTS.CRON.EXPRESSIONS.SYSTEM_MONITORING)
  async handleSystemMonitoring(): Promise<void> {
    try {
      await this.webhookCleanupService.realTimeSystemMonitoring();
    } catch (error) {
      this.logger.error('Scheduled system monitoring failed:', error);
    }
  }

  /**
   * 매시간 레이트 리밋 추적 기록 정리
   */
  @Cron(APP_CONSTANTS.CRON.EXPRESSIONS.RATE_LIMIT_CLEANUP)
  async handleRateLimitCleanup(): Promise<void> {
    try {
      this.logger.debug('Starting scheduled rate limit cleanup...');
      await this.notificationService['cleanupRateLimitTracking']();
      this.logger.debug('Rate limit cleanup completed');
    } catch (error) {
      this.logger.error('Scheduled rate limit cleanup failed:', error);
    }
  }
}
