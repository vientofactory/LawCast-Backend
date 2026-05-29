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
import sharp from 'sharp';
import { APP_CONSTANTS } from '../config/app.config';
import { LoggerUtils } from '../utils/logger.utils';

const SCREENSHOT_CONFIG = {
  enabled: true,
  fullPage: true,
  width: APP_CONSTANTS.SCREENSHOT.WIDTH,
  height: APP_CONSTANTS.SCREENSHOT.HEIGHT,
  format: 'jpeg' as const,
  quality: APP_CONSTANTS.SCREENSHOT.QUALITY,
} as const;

/** JPEG quality levels tried in order when the full-page capture is too large. */
const SCREENSHOT_FALLBACK_QUALITIES =
  APP_CONSTANTS.SCREENSHOT.FALLBACK_QUALITIES;

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
    try {
      return await this.createClient().getContent(contentId);
    } catch (error) {
      this.logger.error(
        `Error fetching content for contentId ${contentId}:`,
        error,
      );
      throw error;
    }
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
    try {
      return await this.createClient().getDoneContent(contentId);
    } catch (error) {
      this.logger.error(
        `Error fetching done content for contentId ${contentId}:`,
        error,
      );
      throw error;
    }
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

  /**
   * Collects **all** active notices across every page using pageUnit=100.
   * Deduplicates by notice number so each notice appears exactly once.
   *
   * @param options.stopBelowNum  When provided, stops as soon as an entire
   *   page contains only notices with `num <= stopBelowNum`.  This is the
   *   "early-exit" optimisation for hot-path cron runs: since notices are
   *   returned newest-first, reaching a page that is entirely known means
   *   every subsequent page is also already known.
   * @param options.delayMs  Overrides the default inter-page delay (ms).
   *   Pass a shorter value for latency-sensitive cron paths.
   * @returns A deduplicated array of all (or remaining-new) active notices.
   */
  async crawlAllPages(options?: {
    stopBelowNum?: number;
    delayMs?: number;
  }): Promise<ITableData[]> {
    const delayMs =
      options?.delayMs ?? APP_CONSTANTS.ARCHIVE_SYNC.CRAWLER_DELAY_MS;
    const stopBelowNum = options?.stopBelowNum;

    const allItems: ITableData[] = [];
    const seen = new Set<number>();

    try {
      for await (const page of this.getAllPages(
        { pageUnit: APP_CONSTANTS.ARCHIVE_SYNC.CRAWLER_PAGE_UNIT },
        { delayMs, concurrency: 1 },
      )) {
        // Guard against unexpected null/undefined items from the crawler
        const pageItems: ITableData[] = page.items ?? [];
        for (const item of pageItems) {
          if (!seen.has(item.num)) {
            seen.add(item.num);
            allItems.push(item);
          }
        }

        // Early-exit: every item on this page is already known -> no need to
        // fetch older pages (notices are ordered newest-first).
        if (
          stopBelowNum !== undefined &&
          pageItems.length > 0 &&
          pageItems.every((item) => item.num <= stopBelowNum)
        ) {
          LoggerUtils.logDev(
            CrawlingCoreService.name,
            `Early exit: all items on page have num ≤ ${stopBelowNum} - skipping older pages`,
          );
          break;
        }
      }
    } catch (error) {
      // Partial-failure recovery: if we already collected items, return them
      // rather than discarding the entire run.  The caller's archive-dedup
      // guard ensures consistency even with an incomplete page set.
      if (allItems.length > 0) {
        this.logger.warn(
          `Stream error after collecting ${allItems.length} items - returning partial data`,
          error,
        );
        return allItems;
      }
      this.logger.error('Error collecting all active notice pages:', error);
      throw error;
    }

    return allItems;
  }

  /**
   * Captures a full-page JPEG screenshot of a notice's content page.
   *
   * If the raw capture exceeds MAX_SIZE_BYTES, the buffer is recompressed
   * with progressively lower JPEG quality values before falling back to a
   * viewport-only (non-full-page) shot.  Returns null only when every
   * strategy still exceeds the limit or an unrecoverable error occurs.
   *
   * @param contentId The content ID of the notice.
   * @param isDone When true, uses the done-notice screenshot endpoint.
   */
  async captureContentScreenshot(
    contentId: string,
    isDone = false,
  ): Promise<Buffer | null> {
    const maxBytes = APP_CONSTANTS.SCREENSHOT.MAX_SIZE_BYTES;

    const doCapture = async (fullPage: boolean): Promise<Buffer> => {
      const client = new PalCrawl({
        ...this.crawlConfig,
        screenshot: { ...SCREENSHOT_CONFIG, fullPage },
      });
      try {
        return isDone
          ? await client.getDoneContentScreenshot(contentId)
          : await client.getContentScreenshot(contentId);
      } finally {
        await client.closeBrowser();
      }
    };

    /**
     * Re-encode a raw JPEG buffer at a lower quality using sharp.
     * Returns the recompressed buffer, or null if still over the limit.
     */
    const recompress = async (
      input: Buffer,
      quality: number,
    ): Promise<Buffer | null> => {
      const result = await sharp(input).jpeg({ quality }).toBuffer();
      return result.length <= maxBytes ? result : null;
    };

    try {
      // ── Step 1: full-page capture at configured quality ──────────────────
      const raw = await doCapture(true);

      if (raw.length <= maxBytes) {
        return raw;
      }

      this.logger.debug(
        `Screenshot for ${contentId} is ${raw.length} B - attempting recompression`,
      );

      // ── Step 2: recompress with decreasing quality levels ────────────────
      for (const quality of SCREENSHOT_FALLBACK_QUALITIES) {
        const recompressed = await recompress(raw, quality);
        if (recompressed) {
          this.logger.debug(
            `Recompressed screenshot for ${contentId} to ${recompressed.length} B (quality=${quality})`,
          );
          return recompressed;
        }
      }

      // ── Step 3: viewport-only (non-full-page) shot ───────────────────────
      this.logger.debug(
        `Full-page recompression exhausted for ${contentId} - retrying viewport-only`,
      );

      const viewport = await doCapture(false);

      if (viewport.length <= maxBytes) {
        this.logger.debug(
          `Viewport screenshot for ${contentId} fits: ${viewport.length} B`,
        );
        return viewport;
      }

      // Try recompressing the viewport shot as a last resort
      for (const quality of SCREENSHOT_FALLBACK_QUALITIES) {
        const recompressed = await recompress(viewport, quality);
        if (recompressed) {
          this.logger.debug(
            `Recompressed viewport screenshot for ${contentId} to ${recompressed.length} B (quality=${quality})`,
          );
          return recompressed;
        }
      }

      this.logger.warn(
        `Screenshot for ${contentId} could not be reduced below ` +
          `${maxBytes} B - discarding`,
      );
      return null;
    } catch (error) {
      this.logger.warn(
        `Screenshot capture failed for ${contentId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }
}
