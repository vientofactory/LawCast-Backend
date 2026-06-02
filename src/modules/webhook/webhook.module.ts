import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Webhook } from './webhook.entity';
import { WebhookService } from './webhook.service';
import { WebhookCleanupService } from './webhook-cleanup.service';

@Module({
  imports: [TypeOrmModule.forFeature([Webhook])],
  providers: [WebhookService, WebhookCleanupService],
  exports: [WebhookService, WebhookCleanupService],
})
export class WebhookModule {}
