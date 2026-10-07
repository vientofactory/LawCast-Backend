import { Module } from '@nestjs/common';
import { SharedModule } from '../shared/shared.module';
import { AdminNoticesController } from './controllers/admin-notices.controller';
import { AdminNoticesService } from './admin-notices.service';

/**
 * Notion-backed admin notice board (read-only). Queries the configured Notion
 * database and serves only published notices sorted by 노출 순서; CRUD stays
 * in Notion, so the module has no write endpoints and no local persistence.
 * SharedModule provides the API read rate limiter.
 */
@Module({
  imports: [SharedModule],
  controllers: [AdminNoticesController],
  providers: [AdminNoticesService],
  exports: [AdminNoticesService],
})
export class AdminNoticesModule {}
