import { Module } from '@nestjs/common';
import { CronJobsService } from './cronjobs.service';
import { WebhookCleanupService } from '../services/webhook-cleanup.service';
import { CrawlingService } from '../services/crawling.service';
import { WebhookService } from '../services/webhook.service';
import { CacheService } from '../services/cache.service';
import { BatchProcessingService } from '../services/batch-processing.service';
import { NotificationService } from '../services/notification.service';
import { Webhook } from '../entities/webhook.entity';
import { TypeOrmModule } from '@nestjs/typeorm';

@Module({
  imports: [TypeOrmModule.forFeature([Webhook])],
  providers: [
    CronJobsService,
    WebhookCleanupService,
    CrawlingService,
    WebhookService,
    CacheService,
    BatchProcessingService,
    NotificationService,
  ],
  exports: [CronJobsService],
})
export class CronJobsModule {}
