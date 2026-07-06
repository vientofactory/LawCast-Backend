import { Injectable } from '@nestjs/common';
import {
  NsmLmSts,
  NsmLmStsParser,
  PalCrawl,
  type IBulkOptions,
  type IContentData,
  type INsmBillDetail,
  type INsmBillItem,
  type INsmSearchQuery,
  type INsmSearchResult,
  type ISearchQuery,
  type ISearchResult,
  type ITableData,
  type PalCrawlConfig,
} from 'pal-crawl';
import sharp from 'sharp';
import { APP_CONSTANTS } from '../../config/app.config';
import { type CachedNotice } from '../../types/cache.types';
import { LoggerUtils } from '../../utils/logger.utils';

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
  private readonly logger = LoggerUtils.getContextLogger(
    CrawlingCoreService.name,
  );
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

  private createNsmClient(): NsmLmSts {
    return new NsmLmSts({
      userAgent: this.crawlConfig.userAgent,
      timeout: this.crawlConfig.timeout,
      retryCount: this.crawlConfig.retryCount,
      customHeaders: this.crawlConfig.customHeaders,
    });
  }

  /**
   * Derives the proposer category (제안자 구분) from the proposer name string.
   * - 위원장 → '위원장'
   * - Contains '의원' → '의원'
   * - Otherwise (government ministry/department name) → '정부'
   */
  static extractProposerCategory(proposer: string): string {
    const s = proposer.trim();
    if (s.includes('위원장')) return '위원장';
    if (s.includes('의원')) return '의원';
    return '정부';
  }

  /**
   * Converts a NsmLmSts bill item into the CachedNotice shape used throughout
   * the archive and notification pipeline.
   *
   * Bills returned by NsmLmSts are in "발의" (proposed) state and do not yet
   * have a pal.assembly.go.kr contentId. The `committee` field from the list
   * page is empty until the bill is referred to a standing committee, so
   * `ministry` (소관부처) is used as a fallback to preserve 소관 information.
   */
  static nsmBillToCachedNotice(item: INsmBillItem): CachedNotice {
    return {
      num: parseInt(item.billNo, 10),
      subject: item.billName,
      proposerCategory: CrawlingCoreService.extractProposerCategory(
        item.proposer,
      ),
      committee: item.committee || item.ministry || '',
      link: item.link,
      contentId: null,
      attachments: { pdfFile: null, hwpFile: null },
      aiSummary: null,
      aiSummaryStatus: 'not_requested' as const,
    };
  }

  /**
   * Get the list of active notices from the crawler.
   * @returns A promise that resolves to an array of notice summaries.
   */
  async crawlData(): Promise<ITableData[]> {
    const crawledData = await this.createClient().get();
    return crawledData?.length ? crawledData : [];
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
    const data = await this.createClient().getDone();
    return data ?? [];
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
    return this.createClient().search(query);
  }

  /**
   * Search for done notices.
   * @param query The search query parameters.
   * @returns A promise that resolves to the search results for done notices.
   */
  async searchDone(query?: ISearchQuery): Promise<ISearchResult> {
    return this.createClient().searchDone(query);
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
    yield* this.createClient().getAllPages(query, options);
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
    yield* this.createClient().getAllDonePages(query, options);
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
   * Fetches the full detail of a single bill from 국회입법현황 (NsmLmSts).
   * Returns the parsed INsmBillDetail including proposalReason, proposalInfo,
   * session, proposer, proposalDate and attachments.
   *
   * @param billNo The 의안번호 of the bill (e.g. "2200001").
   */
  async getNsmDetail(billNo: string): Promise<INsmBillDetail> {
    return this.createNsmClient().getDetail(billNo);
  }

  /**
   * Async generator that yields every page of pending ("발의" status) bills
   * from 국민참여입법센터 (opinion.lawmaking.go.kr) via NsmLmSts.
   *
   * Pending bills are those proposed in the National Assembly but not yet
   * referred to a standing committee. Streaming them here lets the system
   * detect new legislation well before the formal 입법예고 process begins.
   *
   * @param query Optional NsmLmSts search filters (pageIndex is managed internally).
   * @param options Bulk-fetch options (delayMs, concurrency, maxPages).
   */
  async *getAllNsmPendingPages(
    query?: Omit<INsmSearchQuery, 'pageIndex'>,
    options?: IBulkOptions,
  ): AsyncGenerator<INsmSearchResult> {
    yield* this.createNsmClient().getAllPendingPages(query, options);
  }

  /**
   * Captures a screenshot of a bill's detail page on 국회입법현황 (NsmLmSts).
   * Used for pending bills that do not yet have a pal.assembly.go.kr contentId.
   *
   * Applies the same JPEG recompression pipeline as `captureContentScreenshot`
   * to keep screenshots within the configured size limit.
   *
   * @param billNo The 의안번호 of the bill (e.g. "2200001").
   */
  /**
   * Captures everything needed to archive a NSM (opinion.lawmaking.go.kr) bill
   * detail page in a **single Puppeteer session**:
   *
   * - HTML source (bypasses the Waitingroom JS anti-bot challenge that blocks
   *   plain HTTP requests from NsmLmSts.httpClient)
   * - Full-page JPEG screenshot (same recompression pipeline as the old
   *   captureNsmDetailScreenshot)
   * - Parsed INsmBillDetail (proposalReason, proposer, session …) from the
   *   already-loaded page HTML, using NsmLmStsParser from pal-crawl
   *
   * Previously these required two separate Puppeteer launches and one plain
   * HTTP request (getNsmDetail), all of which hit the same URL.
   * This method collapses all three into one browser session.
   *
   * @param billNo 의안번호 (e.g. "2219152")
   */
  async captureNsmDetailFull(billNo: string): Promise<{
    html: string;
    screenshot: Buffer | null;
    detail: INsmBillDetail | null;
    responseUrl: string;
    statusCode: number;
  }> {
    const normalized = billNo.trim();
    if (!normalized) throw new Error('billNo is required');

    const detailUrl = `https://opinion.lawmaking.go.kr/gcom/nsmLmSts/out/${normalized}/detailRP`;
    const maxBytes = APP_CONSTANTS.SCREENSHOT.MAX_SIZE_BYTES;

    const client = new NsmLmSts({
      ...this.crawlConfig,
      screenshot: SCREENSHOT_CONFIG,
    });

    try {
      await client.initBrowser();

      // `browser` is a private JS property - safe to access at runtime.

      const browser = (
        client as unknown as {
          browser: {
            newPage: () => Promise<{
              setViewport: (v: {
                width: number;
                height: number;
              }) => Promise<void>;
              goto: (
                url: string,
                opts: { waitUntil: string; timeout: number },
              ) => Promise<{ status: () => number } | null>;
              waitForNavigation: (opts: {
                waitUntil: string;
                timeout: number;
              }) => Promise<{ status: () => number } | null>;
              title: () => Promise<string>;
              content: () => Promise<string>;
              url: () => string;
              screenshot: (opts: {
                fullPage: boolean;
                type: string;
                quality?: number;
              }) => Promise<Buffer>;
              close: () => Promise<void>;
            }>;
          };
        }
      ).browser;

      const page = await browser.newPage();
      try {
        await page.setViewport({
          width: APP_CONSTANTS.SCREENSHOT.WIDTH,
          height: APP_CONSTANTS.SCREENSHOT.HEIGHT,
        });

        // ── Navigate with Waitingroom bypass ──────────────────────────────
        //
        // opinion.lawmaking.go.kr serves a <title>Waitingroom</title> page
        // that uses a JavaScript polling timer before redirecting to the real
        // detail page.  Using `networkidle0` on the initial goto() resolves as
        // soon as the Waitingroom itself becomes idle (before the JS redirect),
        // so we end up capturing the wrong HTML.
        //
        // Fix:
        //   1. Use `domcontentloaded` - resolves immediately on either the real
        //      page or the Waitingroom without waiting for networkidle.
        //   2. Inspect the page title.  If it's Waitingroom, call
        //      waitForNavigation(networkidle0) to wait for the JS redirect.
        //   3. Up to MAX_WAITINGROOM_RETRIES: if waitForNavigation times out,
        //      reload the URL with a back-off delay and try again.

        const MAX_WAITINGROOM_RETRIES = 2;
        const WAITINGROOM_RETRY_DELAY_MS = 5_000;
        let response: { status: () => number } | null = null;
        let waitingroomHits = 0;

        response = await page.goto(detailUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });

        for (let attempt = 0; attempt <= MAX_WAITINGROOM_RETRIES; attempt++) {
          const pageTitle = await page.title();
          if (!pageTitle.toLowerCase().includes('waitingroom')) break;

          waitingroomHits++;
          LoggerUtils.debugDev(
            CrawlingCoreService.name,
            `NSM bill ${billNo}: Waitingroom hit (attempt ${
              attempt + 1
            }/${MAX_WAITINGROOM_RETRIES + 1}), waiting for redirect…`,
          );

          if (attempt < MAX_WAITINGROOM_RETRIES) {
            try {
              // Wait for the JS redirect to fire and the real page to load.
              const nav = await page.waitForNavigation({
                waitUntil: 'networkidle0',
                timeout: 30_000,
              });
              if (nav) response = nav;
            } catch {
              // waitForNavigation timed out - pause then reload.
              await new Promise<void>((r) =>
                setTimeout(r, WAITINGROOM_RETRY_DELAY_MS * (attempt + 1)),
              );
              response = await page.goto(detailUrl, {
                waitUntil: 'domcontentloaded',
                timeout: 30_000,
              });
            }
          }
        }

        if (waitingroomHits > MAX_WAITINGROOM_RETRIES) {
          this.logger.warn(
            `NSM bill ${billNo}: Waitingroom not resolved after ${
              MAX_WAITINGROOM_RETRIES + 1
            } attempts - HTML may be a Waitingroom page`,
          );
        }

        const html = await page.content();
        const responseUrl = page.url();
        const statusCode = response?.status() ?? 200;

        // Parse detail from the already-loaded HTML - no extra HTTP request.
        let detail: INsmBillDetail | null = null;
        try {
          detail = new NsmLmStsParser().parseDetail(html);
        } catch (err) {
          this.logger.warn(
            `NSM detail parse failed for bill ${billNo}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }

        // Take screenshot in the same session.
        let screenshot: Buffer | null = null;
        try {
          const raw = await page.screenshot({
            fullPage: true,
            type: 'jpeg',
            quality: APP_CONSTANTS.SCREENSHOT.QUALITY,
          });

          if (raw.length <= maxBytes) {
            screenshot = raw;
          } else {
            for (const quality of SCREENSHOT_FALLBACK_QUALITIES) {
              const recompressed = await sharp(raw)
                .jpeg({ quality })
                .toBuffer();
              if (recompressed.length <= maxBytes) {
                screenshot = recompressed;
                break;
              }
            }
            if (!screenshot) {
              this.logger.warn(
                `NSM screenshot for bill ${billNo} could not be reduced below ${
                  maxBytes
                }B - discarding`,
              );
            }
          }
        } catch (err) {
          this.logger.warn(
            `NSM screenshot capture failed for bill ${billNo}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }

        return { html, screenshot, detail, responseUrl, statusCode };
      } finally {
        await page.close();
      }
    } finally {
      await client.closeBrowser();
    }
  }

  /**
   * Captures a full-page JPEG screenshot of a NSM bill detail page.
   * Used by the screenshot backfill queue for bills whose screenshot is still
   * missing after the initial archive (e.g. when captureNsmDetailFull failed).
   *
   * @param billNo 의안번호 (e.g. "2200001")
   */
  async captureNsmDetailScreenshot(billNo: string): Promise<Buffer | null> {
    const maxBytes = APP_CONSTANTS.SCREENSHOT.MAX_SIZE_BYTES;

    const client = new NsmLmSts({
      ...this.crawlConfig,
      screenshot: SCREENSHOT_CONFIG,
    });

    try {
      const raw = await client.getDetailScreenshot(billNo);

      if (raw.length <= maxBytes) return raw;

      LoggerUtils.debugDev(
        CrawlingCoreService.name,
        `NSM screenshot for bill ${billNo} is ${raw.length}B - attempting recompression`,
      );

      for (const quality of SCREENSHOT_FALLBACK_QUALITIES) {
        const recompressed = await sharp(raw).jpeg({ quality }).toBuffer();
        if (recompressed.length <= maxBytes) {
          LoggerUtils.debugDev(
            CrawlingCoreService.name,
            `Recompressed NSM screenshot for bill ${billNo} to ${recompressed.length}B (quality=${quality})`,
          );
          return recompressed;
        }
      }

      this.logger.warn(
        `NSM screenshot for bill ${billNo} could not be reduced below ${maxBytes}B - discarding`,
      );
      return null;
    } finally {
      await client.closeBrowser();
    }
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

    // ── Step 1: full-page capture at configured quality ──────────────────
    const raw = await doCapture(true);

    if (raw.length <= maxBytes) {
      return raw;
    }

    LoggerUtils.debugDev(
      CrawlingCoreService.name,
      `Screenshot for ${contentId} is ${raw.length} B - attempting recompression`,
    );

    // ── Step 2: recompress with decreasing quality levels ────────────────
    for (const quality of SCREENSHOT_FALLBACK_QUALITIES) {
      const recompressed = await recompress(raw, quality);
      if (recompressed) {
        LoggerUtils.debugDev(
          CrawlingCoreService.name,
          `Recompressed screenshot for ${contentId} to ${recompressed.length} B (quality=${quality})`,
        );
        return recompressed;
      }
    }

    // ── Step 3: viewport-only (non-full-page) shot ───────────────────────
    LoggerUtils.debugDev(
      CrawlingCoreService.name,
      `Full-page recompression exhausted for ${contentId} - retrying viewport-only`,
    );

    const viewport = await doCapture(false);

    if (viewport.length <= maxBytes) {
      LoggerUtils.debugDev(
        CrawlingCoreService.name,
        `Viewport screenshot for ${contentId} fits: ${viewport.length} B`,
      );
      return viewport;
    }

    // Try recompressing the viewport shot as a last resort
    for (const quality of SCREENSHOT_FALLBACK_QUALITIES) {
      const recompressed = await recompress(viewport, quality);
      if (recompressed) {
        LoggerUtils.debugDev(
          CrawlingCoreService.name,
          `Recompressed viewport screenshot for ${contentId} to ${recompressed.length} B (quality=${quality})`,
        );
        return recompressed;
      }
    }

    // All size-reduction strategies exhausted - this is a deterministic
    // permanent failure (content is simply too large).  Return null so the
    // caller knows not to retry.
    this.logger.warn(
      `Screenshot for ${contentId} could not be reduced below ` +
        `${maxBytes} B - discarding`,
    );
    return null;
    // NOTE: Exceptions from doCapture / recompress are intentionally NOT
    // caught here.  Transient failures (Puppeteer crash, network timeout,
    // sharp error) propagate to the caller so that the drain loop can decide
    // whether to retry.  Only the size-exceeded case above returns null.
  }
}
