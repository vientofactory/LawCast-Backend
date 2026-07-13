import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NoticeArchive } from './notice-archive.entity';
import { NoticeArchiveSnapshotState } from './notice-archive-summary-state.entity';
import { NoticeArchiveIntegrityCheck } from './notice-archive-integrity-check.entity';
import { NoticeArchiveIntegrityState } from './notice-archive-integrity-state.entity';
import { NoticeArchiveService } from './notice-archive.service';
import { ChangeTrackingModule } from '../change-tracking/change-tracking.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      NoticeArchive,
      NoticeArchiveSnapshotState,
      NoticeArchiveIntegrityCheck,
      NoticeArchiveIntegrityState,
    ]),
    ChangeTrackingModule,
  ],
  providers: [NoticeArchiveService],
  exports: [NoticeArchiveService],
})
export class NoticeModule {}
