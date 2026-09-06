import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DiscussionThread } from './entities/discussion-thread.entity';
import { DiscussionComment } from './entities/discussion-comment.entity';
import { DiscussionsService } from './discussions.service';
import { DiscussionsController } from './controllers/discussions.controller';
import { DiscussionsRateLimitService } from './discussions-rate-limit.service';
import { CacheInfraModule } from '../cache/cache.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([DiscussionThread, DiscussionComment]),
    CacheInfraModule,
  ],
  controllers: [DiscussionsController],
  providers: [DiscussionsService, DiscussionsRateLimitService],
  exports: [DiscussionsService],
})
export class DiscussionsModule {}
