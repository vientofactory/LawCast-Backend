import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NoticeArchive } from './notice-archive.entity';
import { NoticeArchiveService } from './notice-archive.service';
import { ChangeTrackingModule } from '../change-tracking/change-tracking.module';

@Module({
  imports: [TypeOrmModule.forFeature([NoticeArchive]), ChangeTrackingModule],
  providers: [NoticeArchiveService],
  exports: [NoticeArchiveService],
})
export class NoticeModule {}
