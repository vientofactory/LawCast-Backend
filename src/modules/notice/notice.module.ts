import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NoticeArchive } from './notice-archive.entity';
import { NoticeArchiveService } from './notice-archive.service';

@Module({
  imports: [TypeOrmModule.forFeature([NoticeArchive])],
  providers: [NoticeArchiveService],
  exports: [NoticeArchiveService],
})
export class NoticeModule {}
