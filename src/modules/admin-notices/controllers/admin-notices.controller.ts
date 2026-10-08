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

  /**
   * Serves ONE notice for the two cap-1 UI spots so global SSR pages never
   * pull the whole list over the wire: without a query it is the top
   * display-order notice (home hero pinned chip), with `?urgent=true` it is
   * the first urgent notice in display order (site-wide urgent banner).
   * Reads the same cached list as GET /api/announcements, so it never costs
   * an extra Notion request. The response is the cap-1 view (`id`, `title`
   * only — the chip and banner render nothing else) and `item` is null when
   * no notice matches.
   */
  @Get('announcements/top')
  async getTopAdminNotice(@Req() req: Request) {
    await this.apiReadRateLimitService.assertAllowed(req);
    const urgentOnly = req.query.urgent === 'true';
    const items = await this.adminNoticesService.getPublishedNotices();
    const top =
      (urgentOnly ? items.find((notice) => notice.urgent) : items[0]) ?? null;
    const item = top ? { id: top.id, title: top.title } : null;
    return ApiResponseUtils.success({ item });
  }
}
