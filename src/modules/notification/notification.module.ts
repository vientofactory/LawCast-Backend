import { Module } from '@nestjs/common';
import { CacheInfraModule } from '../cache/cache.module';
import { SharedModule } from '../shared/shared.module';
import { WebhookModule } from '../webhook/webhook.module';
import { DiscordBridgeModule } from '../discord-bridge/discord-bridge.module';
import { NotificationService } from './notification.service';
import { NotificationBatchService } from './notification-batch.service';
import { NotificationOrchestratorService } from './notification-orchestrator.service';
import { WebhookRegistrationService } from './webhook-registration.service';

@Module({
  imports: [CacheInfraModule, SharedModule, WebhookModule, DiscordBridgeModule],
  providers: [
    NotificationService,
    NotificationBatchService,
    NotificationOrchestratorService,
    WebhookRegistrationService,
  ],
  exports: [
    NotificationService,
    NotificationBatchService,
    NotificationOrchestratorService,
    WebhookRegistrationService,
  ],
})
export class NotificationModule {}
