import { Controller, Get, Req, UseFilters } from '@nestjs/common';
import type { Request } from 'express';
import { ApiReadRateLimitFilter } from '../../shared/api-read-rate-limit.filter';
import { ApiReadRateLimitService } from '../../shared/api-read-rate-limit.service';
import { ApiResponseUtils } from '../../../utils/api-response.utils';
import { AdminNoticesService } from '../admin-notices.service';

/**
 * Admin notice board endpoint. Read-only by design: notices are authored and
 * published exclusively in Notion, so no create/update/delete routes exist.
 */
@Controller('api')
@UseFilters(ApiReadRateLimitFilter)
export class AdminNoticesController {
  constructor(
    private readonly adminNoticesService: AdminNoticesService,
    private readonly apiReadRateLimitService: ApiReadRateLimitService,
  ) {}

  /**
   * Serves the published notice list ordered by display order. Read-only by
   * design: filtering/sorting is the backend contract, CRUD stays in Notion.
   */
  @Get('announcements')
  async getAdminNotices(@Req() req: Request) {
    await this.apiReadRateLimitService.assertAllowed(req);
    const items = await this.adminNoticesService.getPublishedNotices();
    return ApiResponseUtils.success({ items });
  }
}
