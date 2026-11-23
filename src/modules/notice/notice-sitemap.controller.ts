import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { NoticeSitemapService } from './notice-sitemap.service';

@ApiTags('Sitemap')
@Controller('api/sitemap')
export class NoticeSitemapController {
  constructor(private readonly sitemap: NoticeSitemapService) {}

  // This fixed public artifact has no search/filter inputs and never spends visitor read quotas.
  @Get('notices')
  async getNotices(@Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const snapshot = await this.sitemap.getSnapshot();
    response.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
    return snapshot;
  }
}
