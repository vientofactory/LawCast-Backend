import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ApiController } from './controllers/api.controller';
import { WebhookService } from './services/webhook.service';
import { CrawlingService } from './services/crawling.service';
import { NotificationService } from './services/notification.service';
import { CacheService } from './services/cache.service';
import { RecaptchaService } from './services/recaptcha.service';
import { Webhook } from './entities/webhook.entity';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    TypeOrmModule.forRoot({
      type: 'sqlite',
      database: process.env.DATABASE_PATH || 'lawcast.db',
      entities: [Webhook],
      synchronize: true,
    }),
    TypeOrmModule.forFeature([Webhook]),
    ScheduleModule.forRoot(),
  ],
  controllers: [AppController, ApiController],
  providers: [
    AppService,
    WebhookService,
    CrawlingService,
    NotificationService,
    CacheService,
    RecaptchaService,
  ],
})
export class AppModule {}
