import { Injectable, Logger } from '@nestjs/common';
import { PalCrawl, type ITableData, type PalCrawlConfig } from 'pal-crawl';
import { APP_CONSTANTS } from '../config/app.config';

@Injectable()
export class CrawlingCoreService {
  private readonly logger = new Logger(CrawlingCoreService.name);
  private readonly crawlConfig: PalCrawlConfig;

  constructor() {
    this.crawlConfig = {
      userAgent: APP_CONSTANTS.CRAWLING.USER_AGENT,
      timeout: APP_CONSTANTS.CRAWLING.TIMEOUT,
      retryCount: APP_CONSTANTS.CRAWLING.RETRY_COUNT,
      customHeaders: APP_CONSTANTS.CRAWLING.HEADERS,
    };
  }

  /**
   * 크롤링 데이터를 가져옵니다.
   */
  async crawlData(): Promise<ITableData[]> {
    const palCrawl = new PalCrawl(this.crawlConfig);

    try {
      const crawledData = await palCrawl.get();

      if (!crawledData || crawledData.length === 0) {
        this.logger.warn('No data received from crawler');
        return [];
      }

      this.logger.log(
        `Successfully crawled ${crawledData.length} legislative notices`,
      );
      return crawledData;
    } catch (error) {
      this.logger.error('Error during crawling:', error);
      throw error;
    }
  }

  /**
   * 특정 contentId의 상세 내용을 가져옵니다.
   */
  async getContent(contentId: string): Promise<any> {
    const palCrawl = new PalCrawl(this.crawlConfig);
    return await palCrawl.getContent(contentId);
  }
}
