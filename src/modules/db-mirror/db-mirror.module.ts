import { Module } from '@nestjs/common';
import { DbMirrorService } from './db-mirror.service';
import { DatabaseDumpService } from './database-dump.service';
import { FileKiwiClientService } from './file-kiwi-client.service';

@Module({
  providers: [DbMirrorService, DatabaseDumpService, FileKiwiClientService],
  exports: [DbMirrorService],
})
export class DbMirrorModule {}
