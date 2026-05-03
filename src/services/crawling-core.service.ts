import { Injectable, Logger } from '@nestjs/common';
import {
  PalCrawl,
  type ITableData,
  type IContentData,
  type PalCrawlConfig,
  type ISearchResult,
  type ISearchQuery,
  type IBulkOptions,
} from 'pal-crawl';
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

  private createClient(): PalCrawl {
    return new PalCrawl(this.crawlConfig);
  }

  /**
   * Get the list of active notices from the crawler.
   * @returns A promise that resolves to an array of notice summaries.
   */
  async crawlData(): Promise<ITableData[]> {
    try {
      const crawledData = await this.createClient().get();

      if (!crawledData || crawledData.length === 0) {
        this.logger.warn('No data received from crawler');
        return [];
      }

      return crawledData;
    } catch (error) {
      this.logger.error('Error during crawling:', error);
      throw error;
    }
  }

  /**
   * Get the detailed content of a specific notice by its content ID.
   * @param contentId The unique identifier for the notice content.
   * @returns A promise that resolves to the detailed content data of the notice.
   */
  async getContent(contentId: string): Promise<IContentData> {
    return this.createClient().getContent(contentId);
  }

  /**
   * Get the list of done notices from the crawler.
   * @returns A promise that resolves to an array of done notice summaries.
   */
  async getDone(): Promise<ITableData[]> {
    try {
      const data = await this.createClient().getDone();
      return data ?? [];
    } catch (error) {
      this.logger.error('Error fetching done notices:', error);
      throw error;
    }
  }

  /**
   * Get the detailed content of a done notice by its content ID.
   * @param contentId The unique identifier for the done notice content.
   * @returns A promise that resolves to the detailed content data of the done notice.
   */
  async getDoneContent(contentId: string): Promise<IContentData> {
    return this.createClient().getDoneContent(contentId);
  }

  /**
   * Search for active notices.
   * @param query The search query parameters.
   * @returns A promise that resolves to the search results for active notices.
   */
  async search(query?: ISearchQuery): Promise<ISearchResult> {
    try {
      return await this.createClient().search(query);
    } catch (error) {
      this.logger.error('Error searching active notices:', error);
      throw error;
    }
  }

  /**
   * Search for done notices.
   * @param query The search query parameters.
   * @returns A promise that resolves to the search results for done notices.
   */
  async searchDone(query?: ISearchQuery): Promise<ISearchResult> {
    try {
      return await this.createClient().searchDone(query);
    } catch (error) {
      this.logger.error('Error searching done notices:', error);
      throw error;
    }
  }

  /**
   * Async generator that yields every page of active notices from the crawler.
   * Use `query.pageUnit` (max 100) to control items-per-page, and
   * `options.delayMs` to throttle between requests.
   * @param query Search query parameters (excluding pageIndex).
   * @param options Bulk fetching options (e.g., delayMs for throttling).
   * @returns An async generator yielding search results for all active notices.
   */
  async *getAllPages(
    query?: Omit<ISearchQuery, 'pageIndex'>,
    options?: IBulkOptions,
  ): AsyncGenerator<ISearchResult> {
    try {
      yield* this.createClient().getAllPages(query, options);
    } catch (error) {
      this.logger.error('Error streaming active notice pages:', error);
      throw error;
    }
  }

  /**
   * Async generator that yields every page of done notices from the crawler.
   * Use `query.pageUnit` (max 100) to control items-per-page, and
   * `options.delayMs` to throttle between requests.
   * @param query Search query parameters (excluding pageIndex).
   * @param options Bulk fetching options (e.g., delayMs for throttling).
   * @returns An async generator yielding search results for done notices.
   */
  async *getAllDonePages(
    query?: Omit<ISearchQuery, 'pageIndex'>,
    options?: IBulkOptions,
  ): AsyncGenerator<ISearchResult> {
    try {
      yield* this.createClient().getAllDonePages(query, options);
    } catch (error) {
      this.logger.error('Error streaming done notice pages:', error);
      throw error;
    }
  }
}
