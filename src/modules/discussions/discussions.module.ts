import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DiscussionThread } from './entities/discussion-thread.entity';
import { DiscussionComment } from './entities/discussion-comment.entity';
import { DiscussionsService } from './discussions.service';
import { DiscussionsController } from './discussions.controller';

@Module({
  imports: [TypeOrmModule.forFeature([DiscussionThread, DiscussionComment])],
  controllers: [DiscussionsController],
  providers: [DiscussionsService],
  exports: [DiscussionsService],
})
export class DiscussionsModule {}
