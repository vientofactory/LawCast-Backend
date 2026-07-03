import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CacheInfraModule } from '../cache/cache.module';
import { SharedModule } from '../shared/shared.module';
import { WebhookModule } from '../webhook/webhook.module';
import { DiscordBridgeModule } from '../discord-bridge/discord-bridge.module';
import { NotificationDeliveryLog } from '../change-tracking/notification-delivery-log.entity';
import { NotificationService } from './notification.service';
import { NotificationBatchService } from './notification-batch.service';
import { NotificationOrchestratorService } from './notification-orchestrator.service';

@Module({
  imports: [
    CacheInfraModule,
    SharedModule,
    WebhookModule,
    DiscordBridgeModule,
    TypeOrmModule.forFeature([NotificationDeliveryLog]),
  ],
  providers: [
    NotificationService,
    NotificationBatchService,
    NotificationOrchestratorService,
  ],
  exports: [
    NotificationService,
    NotificationBatchService,
    NotificationOrchestratorService,
  ],
})
export class NotificationModule {}
