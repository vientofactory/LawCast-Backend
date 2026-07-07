import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { CacheModule } from '@nestjs/cache-manager';
import { createKeyv } from '@keyv/redis';
import { ApiController } from './controllers/api.controller';
import { Webhook } from './modules/webhook/webhook.entity';
import { NoticeArchive } from './modules/notice/notice-archive.entity';
import { NoticeArchiveSnapshotState } from './modules/notice/notice-archive-summary-state.entity';
import { NoticeChangeEvent } from './modules/change-tracking/notice-change-event.entity';
import { NoticeChangeDetail } from './modules/change-tracking/notice-change-detail.entity';
import { migrations } from './migrations';
import appConfig from './config/app.config';
// Feature modules
import { CacheInfraModule } from './modules/cache/cache.module';
import { SharedModule } from './modules/shared/shared.module';
import { NoticeModule } from './modules/notice/notice.module';
import { WebhookModule } from './modules/webhook/webhook.module';
import { NotificationModule } from './modules/notification/notification.module';
import { CrawlingModule } from './modules/crawling/crawling.module';
import { HealthModule } from './modules/health/health.module';
import { SchedulingModule } from './modules/scheduling/scheduling.module';
import { OllamaModule } from './modules/ollama/ollama.module';
import { DiscordBridgeModule } from './modules/discord-bridge/discord-bridge.module';
import { ChangeTrackingModule } from './modules/change-tracking/change-tracking.module';

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
        entities: [
          Webhook,
          NoticeArchive,
          NoticeArchiveSnapshotState,
          NoticeChangeEvent,
          NoticeChangeDetail,
        ],
        synchronize: false,
        migrationsRun: false,
        migrationsTableName: 'migrations',
        migrations,
      }),
    }),
    ScheduleModule.forRoot(),
    // Infrastructure
    CacheInfraModule,
    SharedModule,
    // Feature modules
    NoticeModule,
    WebhookModule,
    NotificationModule,
    CrawlingModule,
    HealthModule,
    SchedulingModule,
    ChangeTrackingModule,
    // Third-party integration modules
    OllamaModule,
    DiscordBridgeModule,
  ],
  controllers: [ApiController],
})
export class AppModule {}
