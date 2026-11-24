import { Module } from '@nestjs/common';
import { DbMirrorService } from './db-mirror.service';
import { DatabaseDumpService } from './database-dump.service';
import { FileKiwiUploadWorkerService } from './file-kiwi-upload-worker.service';

@Module({
  providers: [
    DbMirrorService,
    DatabaseDumpService,
    FileKiwiUploadWorkerService,
  ],
  exports: [DbMirrorService],
})
export class DbMirrorModule {}
