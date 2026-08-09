import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CacheInfraModule } from '../cache/cache.module';
import { SharedModule } from '../shared/shared.module';
import { WebhookModule } from '../webhook/webhook.module';
import { DiscordBridgeModule } from '../discord-bridge/discord-bridge.module';
import { NotificationService } from './notification.service';
import { NotificationBatchService } from './notification-batch.service';
import { NotificationOrchestratorService } from './notification-orchestrator.service';
import { WebhookRegistrationService } from './webhook-registration.service';
import { WebPushSubscription } from './web-push-subscription.entity';
import { WebPushSubscriptionService } from './web-push-subscription.service';
import { WebPushNotificationService } from './web-push-notification.service';
import { WebPushRegistrationService } from './web-push-registration.service';

@Module({
  imports: [
    CacheInfraModule,
    SharedModule,
    WebhookModule,
    DiscordBridgeModule,
    TypeOrmModule.forFeature([WebPushSubscription]),
  ],
  providers: [
    NotificationService,
    NotificationBatchService,
    NotificationOrchestratorService,
    WebhookRegistrationService,
    WebPushRegistrationService,
    WebPushSubscriptionService,
    WebPushNotificationService,
  ],
  exports: [
    NotificationService,
    NotificationBatchService,
    NotificationOrchestratorService,
    WebhookRegistrationService,
    WebPushRegistrationService,
    WebPushSubscriptionService,
    WebPushNotificationService,
  ],
})
export class NotificationModule {}
