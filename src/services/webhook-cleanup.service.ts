import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { WebhookService } from './webhook.service';
import { APP_CONSTANTS } from '../config/app.config';

@Injectable()
export class WebhookCleanupService {
  private readonly logger = new Logger(WebhookCleanupService.name);

  constructor(private readonly webhookService: WebhookService) {}

  /**
   * 매일 자정에 웹훅 정리 수행
   * 시스템 효율성을 자동으로 평가하고 필요시 정리 실행
   */
  @Cron(APP_CONSTANTS.CRON.EXPRESSIONS.WEBHOOK_CLEANUP)
  async intelligentWebhookCleanup(): Promise<void> {
    try {
      this.logger.log('Starting intelligent webhook cleanup analysis...');

      const stats = await this.webhookService.getDetailedStats();
      const efficiency =
        stats.total > 0 ? (stats.active / stats.total) * 100 : 100;

      this.logger.log(
        `System efficiency: ${efficiency.toFixed(1)}% (${stats.active}/${stats.total} active webhooks)`,
      );

      let totalCleaned = 0;

      // 1. 항상 오래된 비활성 웹훅 정리 (14일 이상)
      if (stats.oldInactive > 0) {
        const oldCleaned =
          await this.webhookService.cleanupOldInactiveWebhooks(14);
        totalCleaned += oldCleaned;
        this.logger.log(
          `Cleaned ${oldCleaned} old inactive webhooks (14+ days)`,
        );
      }

      // 2. 효율성이 낮으면 추가 정리 수행
      if (efficiency < 70) {
        const recentInactiveCleaned =
          await this.webhookService.cleanupOldInactiveWebhooks(7);
        totalCleaned += recentInactiveCleaned;
        this.logger.log(
          `Low efficiency detected. Cleaned ${recentInactiveCleaned} recent inactive webhooks (7+ days)`,
        );
      }

      // 3. 극도로 낮은 효율성이면 모든 비활성 웹훅 정리
      if (efficiency < 50) {
        const allInactiveCleaned =
          await this.webhookService.cleanupInactiveWebhooks();
        totalCleaned += allInactiveCleaned;
        this.logger.warn(
          `Critical efficiency level. Cleaned all ${allInactiveCleaned} inactive webhooks`,
        );
      }

      const finalStats = await this.webhookService.getDetailedStats();
      const finalEfficiency =
        finalStats.total > 0
          ? (finalStats.active / finalStats.total) * 100
          : 100;

      this.logger.log(
        `Cleanup completed: ${totalCleaned} webhooks removed. Efficiency improved from ${efficiency.toFixed(1)}% to ${finalEfficiency.toFixed(1)}%`,
      );
    } catch (error) {
      this.logger.error(
        'Failed to perform intelligent webhook cleanup:',
        error,
      );
    }
  }

  /**
   * 매일 새벽 2시에 심층 시스템 최적화 수행
   */
  @Cron(APP_CONSTANTS.CRON.EXPRESSIONS.WEBHOOK_OPTIMIZATION)
  async weeklySystemOptimization(): Promise<void> {
    try {
      this.logger.log('Starting weekly system optimization...');

      const stats = await this.webhookService.getDetailedStats();
      const efficiency =
        stats.total > 0 ? (stats.active / stats.total) * 100 : 100;

      // 데이터베이스 조각 모음을 위한 전면 정리 (효율성이 80% 미만인 경우)
      if (efficiency < 80 && stats.inactive > 0) {
        const deletedCount =
          await this.webhookService.cleanupInactiveWebhooks();
        this.logger.log(
          `Weekly optimization: removed ${deletedCount} inactive webhooks for DB defragmentation`,
        );
      }

      // 시스템 상태 보고
      const finalStats = await this.webhookService.getDetailedStats();
      const finalEfficiency =
        finalStats.total > 0
          ? (finalStats.active / finalStats.total) * 100
          : 100;

      this.logger.log(
        `Weekly optimization completed. Final system state: ${finalStats.active} active webhooks, ${finalEfficiency.toFixed(1)}% efficiency`,
      );

      // 경고 로그 (관리 필요 시에만)
      if (finalStats.total > 2000) {
        this.logger.warn(
          `High webhook count detected: ${finalStats.total} total webhooks. Consider system review.`,
        );
      }
    } catch (error) {
      this.logger.error('Failed to perform weekly system optimization:', error);
    }
  }

  /**
   * 매시간 실시간 시스템 모니터링 및 자가 치유
   */
  @Cron(APP_CONSTANTS.CRON.EXPRESSIONS.SYSTEM_MONITORING)
  async realTimeSystemMonitoring(): Promise<void> {
    try {
      const stats = await this.webhookService.getDetailedStats();
      const efficiency =
        stats.total > 0 ? (stats.active / stats.total) * 100 : 100;

      // 임계 상황 감지 및 즉시 대응
      if (efficiency < 30 && stats.total > 100) {
        const emergencyCleaned =
          await this.webhookService.cleanupInactiveWebhooks();
        this.logger.warn(
          `🚨 Emergency cleanup triggered! System efficiency was ${efficiency.toFixed(1)}%. Cleaned ${emergencyCleaned} inactive webhooks.`,
        );
      } else if (stats.oldInactive > 50) {
        const preventiveCleaned =
          await this.webhookService.cleanupOldInactiveWebhooks(3);
        this.logger.log(
          `🔧 Preventive maintenance: cleaned ${preventiveCleaned} old inactive webhooks to prevent efficiency degradation.`,
        );
      }
    } catch (error) {
      this.logger.error(
        'Failed to perform real-time system monitoring:',
        error,
      );
    }
  }

  /**
   * 시스템 자가 진단 및 자동 복구
   */
  async performSelfDiagnostics(): Promise<{
    systemHealth: 'excellent' | 'good' | 'fair' | 'poor' | 'critical';
    autoActionsPerformed: string[];
  }> {
    const stats = await this.webhookService.getDetailedStats();
    const efficiency =
      stats.total > 0 ? (stats.active / stats.total) * 100 : 100;
    const autoActions: string[] = [];

    // 자동 복구 액션 수행
    if (efficiency < 40) {
      const cleaned = await this.webhookService.cleanupOldInactiveWebhooks(1);
      autoActions.push(`Cleaned ${cleaned} recent inactive webhooks`);
    }

    // 시스템 상태 평가
    let systemHealth: 'excellent' | 'good' | 'fair' | 'poor' | 'critical';
    if (efficiency >= 90) systemHealth = 'excellent';
    else if (efficiency >= 80) systemHealth = 'good';
    else if (efficiency >= 60) systemHealth = 'fair';
    else if (efficiency >= 40) systemHealth = 'poor';
    else systemHealth = 'critical';

    this.logger.log(
      `Self-diagnostics completed: ${systemHealth} (${efficiency.toFixed(1)}% efficiency), ${autoActions.length} auto-actions performed`,
    );

    return {
      systemHealth,
      autoActionsPerformed: autoActions,
    };
  }
}
