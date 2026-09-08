import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DiscussionThread } from './entities/discussion-thread.entity';
import { DiscussionComment } from './entities/discussion-comment.entity';
import { DiscussionsService } from './discussions.service';
import { DiscussionsController } from './controllers/discussions.controller';
import { DiscussionsRateLimitService } from './discussions-rate-limit.service';
import { CacheInfraModule } from '../cache/cache.module';
import { NotificationModule } from '../notification/notification.module';
import { DiscussionNotificationService } from './discussion-notification.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([DiscussionThread, DiscussionComment]),
    CacheInfraModule,
    NotificationModule,
  ],
  controllers: [DiscussionsController],
  providers: [
    DiscussionsService,
    DiscussionsRateLimitService,
    DiscussionNotificationService,
  ],
  exports: [DiscussionsService],
})
export class DiscussionsModule {}
