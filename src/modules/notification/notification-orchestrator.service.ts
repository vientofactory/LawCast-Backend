import { Injectable, Optional } from '@nestjs/common';
import { type CachedNotice } from '../../types/cache.types';
import { LoggerUtils } from '../../utils/logger.utils';
import { NotificationBatchService } from './notification-batch.service';
import { BatchProcessingOptions } from '../shared/batch-processing.service';
import { DiscordBridgeService } from '../discord-bridge/discord-bridge.service';
import { BridgeLogLevel } from '../discord-bridge/discord-bridge.types';
import { logAndBridge } from '../../utils/bridge-log.utils';

@Injectable()
export class NotificationOrchestratorService {
  private readonly logger = LoggerUtils.getContextLogger(
    NotificationOrchestratorService.name,
  );

  constructor(
    private notificationBatchService: NotificationBatchService,
    @Optional() private discordBridge: DiscordBridgeService,
  ) {}

  /**
   * Executes the notification batch processing and waits for completion.
   * @param notices The array of cached notices to be processed.
   */
  async sendNotifications(notices: CachedNotice[]): Promise<void> {
    try {
      // Apply batch size limit for large notification batches
      const options: BatchProcessingOptions = {
        concurrency: 5,
        timeout: 30000,
        retryCount: 3,
        retryDelay: 1000,
      };

      // Apply batch size limit if there are more than 50 notifications
      if (notices.length > 50) {
        options.batchSize = 50;
        logAndBridge({
          logger: this.logger,
          method: 'log',
          message: `Large notification batch detected (${notices.length} notices), applying batch size limit of 50`,
          context: NotificationOrchestratorService.name,
          discordBridge: this.discordBridge,
          bridgeLevel: BridgeLogLevel.DEBUG,
          bridgeMessage: `Large batch detected: **${notices.length}** notices - applying batch size limit of 50`,
          metadata: { noticeCount: notices.length, batchSizeLimit: 50 },
        });
      }

      // Start batch processing and get the jobId
      const jobId =
        await this.notificationBatchService.processNotificationBatch(
          notices,
          options,
        );

      logAndBridge({
        logger: this.logger,
        method: 'log',
        message: `Started notification batch processing for ${notices.length} notices (job: ${jobId})`,
        context: NotificationOrchestratorService.name,
        discordBridge: this.discordBridge,
        bridgeLevel: BridgeLogLevel.DEBUG,
        bridgeMessage: `Notification batch dispatched: **${notices.length}** notice(s) (job: \`${jobId}\`)`,
        metadata: { noticeCount: notices.length, jobId },
      });

      this.logger.log(
        `Notification batch processing is running asynchronously for ${notices.length} notices`,
      );
    } catch (error) {
      this.logger.error('Notification batch processing failed:', error);
      throw error;
    }
  }
}
