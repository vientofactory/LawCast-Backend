import { Injectable, Logger, Optional } from '@nestjs/common';
import { type CachedNotice } from '../types/cache.types';
import { NotificationBatchService } from './notification-batch.service';
import { BatchProcessingOptions } from './batch-processing.service';
import { DiscordBridgeService } from '../modules/discord-bridge/discord-bridge.service';
import { BridgeLogLevel } from '../modules/discord-bridge/discord-bridge.types';

@Injectable()
export class NotificationOrchestratorService {
  private readonly logger = new Logger(NotificationOrchestratorService.name);

  constructor(
    private notificationBatchService: NotificationBatchService,
    @Optional() private discordBridge: DiscordBridgeService,
  ) {}

  /**
   * 알림 배치 처리를 실행하고 완료를 기다림
   */
  async sendNotifications(notices: CachedNotice[]): Promise<void> {
    try {
      // 대량 알림의 경우 배치 크기 제한 적용
      const options: BatchProcessingOptions = {
        concurrency: 5,
        timeout: 30000,
        retryCount: 3,
        retryDelay: 1000,
      };

      // 50개 이상의 알림이 있는 경우 배치 크기 제한 적용
      if (notices.length > 50) {
        options.batchSize = 50;
        this.logger.log(
          `Large notification batch detected (${notices.length} notices), applying batch size limit of 50`,
        );
        void this.discordBridge.logEvent(
          BridgeLogLevel.DEBUG,
          NotificationOrchestratorService.name,
          `Large batch detected: **${notices.length}** notices — applying batch size limit of 50`,
          { noticeCount: notices.length, batchSizeLimit: 50 },
        );
      }

      // 배치 처리 시작하고 jobId 받기
      const jobId =
        await this.notificationBatchService.processNotificationBatch(
          notices,
          options,
        );

      this.logger.log(
        `Started notification batch processing for ${notices.length} notices (job: ${jobId})`,
      );
      void this.discordBridge.logEvent(
        BridgeLogLevel.DEBUG,
        NotificationOrchestratorService.name,
        `Notification batch dispatched: **${notices.length}** notice(s) (job: \`${jobId}\`)`,
        { noticeCount: notices.length, jobId },
      );

      this.logger.log(
        `Notification batch processing is running asynchronously for ${notices.length} notices`,
      );
    } catch (error) {
      this.logger.error('Notification batch processing failed:', error);
      throw error;
    }
  }
}
