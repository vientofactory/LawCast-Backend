import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { ApiController } from './controllers/api.controller';
import { WebhookService } from './services/webhook.service';
import { CrawlingService } from './services/crawling.service';
import { NotificationService } from './services/notification.service';
import { CacheService } from './services/cache.service';
import { RecaptchaService } from './services/recaptcha.service';
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
  ],
  controllers: [ApiController],
  providers: [
    WebhookService,
    CrawlingService,
    NotificationService,
    CacheService,
    RecaptchaService,
  ],
})
export class AppModule {}
