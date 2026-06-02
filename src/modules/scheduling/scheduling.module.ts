import { Module } from '@nestjs/common';
import { WebhookModule } from '../webhook/webhook.module';
import { CrawlingModule } from '../crawling/crawling.module';
import { DiscordBridgeModule } from '../discord-bridge/discord-bridge.module';
import { CronJobsService } from './cronjobs.service';

@Module({
  imports: [WebhookModule, CrawlingModule, DiscordBridgeModule],
  providers: [CronJobsService],
})
export class SchedulingModule {}
