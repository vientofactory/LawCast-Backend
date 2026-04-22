import { Injectable, Logger } from '@nestjs/common';
import { WebhookService } from './webhook.service';

@Injectable()
export class WebhookCleanupService {
  private readonly logger = new Logger(WebhookCleanupService.name);

  constructor(private readonly webhookService: WebhookService) {}

  /**
   * Cleanup webhooks based on intelligent analysis of system state
   * @returns void
   */
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

      // 1. Clean up old inactive webhooks if they exist (14+ days inactive)
      if (stats.oldInactive > 0) {
        const oldCleaned =
          await this.webhookService.cleanupOldInactiveWebhooks(14);
        totalCleaned += oldCleaned;
        this.logger.log(
          `Cleaned ${oldCleaned} old inactive webhooks (14+ days)`,
        );
      }

      // 2. Clean up recent inactive webhooks if efficiency is low (7+ days inactive)
      if (efficiency < 70) {
        const recentInactiveCleaned =
          await this.webhookService.cleanupOldInactiveWebhooks(7);
        totalCleaned += recentInactiveCleaned;
        this.logger.log(
          `Low efficiency detected. Cleaned ${recentInactiveCleaned} recent inactive webhooks (7+ days)`,
        );
      }

      // 3. Emergency cleanup if efficiency is critically low (all inactive webhooks)
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
   * System optimization task
   * @returns void
   */
  async runSystemOptimization(): Promise<void> {
    try {
      this.logger.log('Starting weekly system optimization...');

      const stats = await this.webhookService.getDetailedStats();
      const efficiency =
        stats.total > 0 ? (stats.active / stats.total) * 100 : 100;

      // Clean up inactive webhooks for database defragmentation if efficiency is below 80%
      if (efficiency < 80 && stats.inactive > 0) {
        const deletedCount =
          await this.webhookService.cleanupInactiveWebhooks();
        this.logger.log(
          `Weekly optimization: removed ${deletedCount} inactive webhooks for DB defragmentation`,
        );
      }

      // Report final system state after optimization
      const finalStats = await this.webhookService.getDetailedStats();
      const finalEfficiency =
        finalStats.total > 0
          ? (finalStats.active / finalStats.total) * 100
          : 100;

      this.logger.log(
        `Weekly optimization completed. Final system state: ${finalStats.active} active webhooks, ${finalEfficiency.toFixed(1)}% efficiency`,
      );

      // Warning log
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
   * Monitor system in real-time and take immediate actions if needed
   * @returns void
   */
  async realTimeSystemMonitoring(): Promise<void> {
    try {
      const stats = await this.webhookService.getDetailedStats();
      const efficiency =
        stats.total > 0 ? (stats.active / stats.total) * 100 : 100;
      if (efficiency < 30 && stats.total > 100) {
        const emergencyCleaned =
          await this.webhookService.cleanupInactiveWebhooks();
        this.logger.warn(
          `Emergency cleanup triggered! System efficiency was ${efficiency.toFixed(1)}%. Cleaned ${emergencyCleaned} inactive webhooks.`,
        );
      } else if (stats.oldInactive > 50) {
        const preventiveCleaned =
          await this.webhookService.cleanupOldInactiveWebhooks(3);
        this.logger.log(
          `Preventive maintenance: cleaned ${preventiveCleaned} old inactive webhooks to prevent efficiency degradation.`,
        );
      }
    } catch (error) {
      this.logger.error(
        'Failed to perform real-time system monitoring:',
        error,
      );
    }
  }

  async performSelfDiagnostics(): Promise<{
    systemHealth: 'excellent' | 'good' | 'fair' | 'poor' | 'critical';
    autoActionsPerformed: string[];
  }> {
    const stats = await this.webhookService.getDetailedStats();
    const efficiency =
      stats.total > 0 ? (stats.active / stats.total) * 100 : 100;
    const autoActions: string[] = [];

    // Perform automatic recovery actions based on diagnostics
    if (efficiency < 40) {
      const cleaned = await this.webhookService.cleanupOldInactiveWebhooks(1);
      autoActions.push(`Cleaned ${cleaned} recent inactive webhooks`);
    }

    // Evaluate system health
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
