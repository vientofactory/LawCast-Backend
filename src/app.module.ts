import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { CacheModule } from '@nestjs/cache-manager';
import { createKeyv } from '@keyv/redis';
import { ApiController } from './controllers/api.controller';
import { WebhookService } from './services/webhook.service';
import { CrawlingService } from './services/crawling.service';
import { NotificationService } from './services/notification.service';
import { CacheService } from './services/cache.service';
import { HashguardService } from './services/hashguard.service';
import { BatchProcessingService } from './services/batch-processing.service';
import { CronJobsService } from './cronjobs/cronjobs.service';
import { WebhookCleanupService } from './services/webhook-cleanup.service';
import { RuntimeStatsService } from './services/runtime-stats.service';
import { NoticesQueryService } from './services/notices-query.service';
import { Webhook } from './entities/webhook.entity';
import { NoticeArchive } from './entities/notice-archive.entity';
import { OllamaModule } from './modules/ollama/ollama.module';
import { NoticeArchiveService } from './services/notice-archive.service';
import { NotificationBatchService } from './services/notification-batch.service';
import { InitialSchemaMigration1744953900000 } from './migrations/202604170001-initial-schema.migration';
import { AddContentMetadataColumns1745001601000 } from './migrations/202604180001-add-content-metadata-columns.migration';
import { AddIsDoneColumn1746316801000 } from './migrations/202605030001-add-is-done-column.migration';
import { CrawlingCoreService } from './services/crawling-core.service';
import { SummaryGenerationService } from './services/summary-generation.service';
import { ArchiveOrchestratorService } from './services/archive-orchestrator.service';
import { NotificationOrchestratorService } from './services/notification-orchestrator.service';
import { CrawlingSchedulerService } from './services/crawling-scheduler.service';
import { HealthCheckService } from './services/health-check.service';
import { NoticeSearchService } from './services/notice-search.service';
import { ArchiveSyncService } from './services/archive-sync.service';
import { DiscordBridgeModule } from './modules/discord-bridge/discord-bridge.module';
import appConfig from './config/app.config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
      envFilePath: [
        '.env',
        '.env.local',
        '.env.development',
        '.env.production',
      ],
    }),
    CacheModule.registerAsync({
      isGlobal: true,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const redisUrl = configService.get<string>('redis.url');
        const keyPrefix = configService.get<string>('redis.keyPrefix');
        return {
          stores: [
            createKeyv(redisUrl, {
              namespace: keyPrefix,
            }),
          ],
        };
      },
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'sqlite',
        database: configService.get<string>('database.path'),
        entities: [Webhook, NoticeArchive],
        synchronize: false,
        migrationsRun: false,
        migrationsTableName: 'migrations',
        migrations: [
          InitialSchemaMigration1744953900000,
          AddContentMetadataColumns1745001601000,
          AddIsDoneColumn1746316801000,
        ],
      }),
    }),
    TypeOrmModule.forFeature([Webhook, NoticeArchive]),
    ScheduleModule.forRoot(),
    OllamaModule,
    DiscordBridgeModule,
  ],
  controllers: [ApiController],
  providers: [
    WebhookService,
    CrawlingService,
    NotificationService,
    CacheService,
    HashguardService,
    BatchProcessingService,
    NotificationBatchService,
    NoticeArchiveService,
    NoticesQueryService,
    WebhookCleanupService,
    CronJobsService,
    RuntimeStatsService,
    CrawlingCoreService,
    SummaryGenerationService,
    ArchiveOrchestratorService,
    NotificationOrchestratorService,
    CrawlingSchedulerService,
    HealthCheckService,
    NoticeSearchService,
    ArchiveSyncService,
  ],
})
export class AppModule {}
