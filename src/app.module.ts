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
import { RecaptchaService } from './services/recaptcha.service';
import { BatchProcessingService } from './services/batch-processing.service';
import { CronJobsModule } from './cronjobs/cronjobs.module';
import { Webhook } from './entities/webhook.entity';
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
        const ttl = configService.get<number>('redis.ttl') * 1000;

        return {
          stores: [
            createKeyv(redisUrl, {
              namespace: keyPrefix,
            }),
          ],
          ttl,
        };
      },
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'sqlite',
        database: configService.get<string>('database.path'),
        entities: [Webhook],
        synchronize: true,
      }),
    }),
    TypeOrmModule.forFeature([Webhook]),
    ScheduleModule.forRoot(),
    CronJobsModule,
  ],
  controllers: [ApiController],
  providers: [
    WebhookService,
    CrawlingService,
    NotificationService,
    CacheService,
    RecaptchaService,
    BatchProcessingService,
  ],
})
export class AppModule {}
