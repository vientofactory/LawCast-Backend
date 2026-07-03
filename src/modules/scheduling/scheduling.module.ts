import { Module } from '@nestjs/common';
import { WebhookModule } from '../webhook/webhook.module';
import { CrawlingModule } from '../crawling/crawling.module';
import { DiscordBridgeModule } from '../discord-bridge/discord-bridge.module';
import { ChangeTrackingModule } from '../change-tracking/change-tracking.module';
import { CronJobsService } from './cronjobs.service';

@Module({
  imports: [
    WebhookModule,
    CrawlingModule,
    DiscordBridgeModule,
    ChangeTrackingModule,
  ],
  providers: [CronJobsService],
})
export class SchedulingModule {}
