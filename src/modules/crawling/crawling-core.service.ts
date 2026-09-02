import { Injectable } from '@nestjs/common';
import {
  NsmLmSts,
  NsmLmStsParser,
  PalCrawl,
  type IBulkOptions,
  type IContentData,
  type INsmBillDetail,
  type INsmBillItem,
  type ISearchQuery,
  type ISearchResult,
  type INsmSearchQuery,
  type INsmSearchResult,
  type ITableData,
  type PalCrawlConfig,
} from 'pal-crawl';
import { URL } from 'node:url';
import sharp from 'sharp';
import { APP_CONSTANTS } from '../../config/app.config';
import { type CachedNotice } from '../../types/cache.types';
import { fetchHtmlPage } from '../../utils/http-fetch.utils';
import { LoggerUtils } from '../../utils/logger.utils';
import { BrowserLeaseManagerService } from './browser-lease-manager.service';
import { recoverCompetentAuthorityName } from './utils/competent-authority-autocomplete.utils';
import {
  navigateWithWaitingroomBypass,
  fetchPageHtmlViaBrowser,
  isWaitingroomRedirectError,
  isWaitingroomPage,
  isWaitingroomHtml,
} from './utils/waitingroom-bypass';

/**
 * Enriched error that attaches crawl phase, page index, and bill number
 * context to pal-crawl HTTP errors (which only carry a bare message like
 * "Invalid response: 307 Temporary Redirect").
 *
 * The extra fields are read by `toPendingErrorDiagnostics` in the
 * crawling-scheduler-pending-support module to produce actionable logs.
 */
export class NsmCrawlContextError extends Error {
  readonly crawlPhase: string;
  readonly crawlPageIndex?: number;
  readonly crawlBillNo?: string;
  readonly cause?: unknown;

  constructor(
    message: string,
    context: {
      phase: string;
      pageIndex?: number;
      billNo?: string;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'NsmCrawlContextError';
    this.crawlPhase = context.phase;
    this.crawlPageIndex = context.pageIndex;
    this.crawlBillNo = context.billNo;
    this.cause = context.cause;
  }
}

const SCREENSHOT_CONFIG = {
  enabled: true,
  fullPage: true,
  width: APP_CONSTANTS.SCREENSHOT.WIDTH,
  height: APP_CONSTANTS.SCREENSHOT.HEIGHT,
  format: 'jpeg' as const,
  quality: APP_CONSTANTS.SCREENSHOT.QUALITY,
} as const;

type NsmCrawlConfig = PalCrawlConfig & {
  hydrateTruncatedTitles?: boolean;
};

/** JPEG quality levels tried in order when the full-page capture is too large. */
const SCREENSHOT_FALLBACK_QUALITIES =
  APP_CONSTANTS.SCREENSHOT.FALLBACK_QUALITIES;

type NsmDeletionCheck = {
  confirmed: boolean;
  alertMessage: string | null;
};

export class NsmBillDeletedError extends Error {
  readonly billNo: string;
  readonly responseUrl?: string;
  readonly alertMessage: string;

  constructor(
    billNo: string,
    alertMessage: string,
    options?: { responseUrl?: string },
  ) {
    super(`NSM bill ${billNo} appears deleted: ${alertMessage}`);
    this.name = 'NsmBillDeletedError';
    this.billNo = billNo;
    this.alertMessage = alertMessage;
    this.responseUrl = options?.responseUrl;
  }
}

/**
 * Thrown when the Waitingroom could not be bypassed within the retry budget.
 * The captured page is not the real detail page, so it must never be fed
 * into deletion detection (or detail parsing) — distinct from
 * `NsmBillDeletedError` so callers never mistake it for a confirmed deletion.
 */
export class NsmWaitingroomUnresolvedError extends Error {
  readonly billNo: string;

  constructor(billNo: string) {
    super(`NSM bill ${billNo}: Waitingroom was not resolved before capture`);
    this.name = 'NsmWaitingroomUnresolvedError';
    this.billNo = billNo;
  }
}

export function buildNsmDetailUrl(billNo: string): string {
  return `https://opinion.lawmaking.go.kr/gcom/nsmLmSts/out/${billNo.trim()}/detailRP`;
}

@Injectable()
export class CrawlingCoreService {
  private readonly logger = LoggerUtils.getContextLogger(
    CrawlingCoreService.name,
  );
  private readonly crawlConfig: NsmCrawlConfig;

  constructor(
    private readonly browserLeaseManager: BrowserLeaseManagerService,
  ) {
    this.crawlConfig = {
      userAgent: APP_CONSTANTS.CRAWLING.USER_AGENT,
      timeout: APP_CONSTANTS.CRAWLING.TIMEOUT,
      retryCount: APP_CONSTANTS.CRAWLING.RETRY_COUNT,
      customHeaders: APP_CONSTANTS.CRAWLING.HEADERS,
      hydrateTruncatedTitles:
        APP_CONSTANTS.CRAWLING.NSM_HYDRATE_TRUNCATED_TITLES,
    };
  }

  private createClient(): PalCrawl {
    return new PalCrawl(this.crawlConfig);
  }

  private createNsmClient(): NsmLmSts {
    return new NsmLmSts(this.crawlConfig);
  }

  /**
   * Builds the NSM list page URL, replicating NsmLmSts.buildListUrl (which is
   * private). Used by the Puppeteer-based fallback when the HTTP client hits
   * a Waitingroom 307.
   */
  private static buildNsmListUrl(
    query: Omit<INsmSearchQuery, 'pageIndex'> & { pageIndex?: number } = {},
  ): URL {
    const url = new URL(
      '/gcom/nsmLmSts/out',
      'https://opinion.lawmaking.go.kr',
    );
    const entries: Array<[string, unknown]> = [
      ['pageIndex', query.pageIndex],
      ['pageSize', query.pageSize],
      ['sugCd', query.sugCd],
      ['endSugCd', query.endSugCd],
      ['sgtCls', query.sgtCls],
      ['cptOfiOrgCd', query.cptOfiOrgCd],
      ['rslRsltNmL', query.rslRsltNmL],
      ['rslRsltNmR', query.rslRsltNmR],
      ['scCptPpostCmt', query.scCptPpostCmt],
      ['searchStDtNew', query.searchStDtNew],
      ['searchEdDtNew', query.searchEdDtNew],
      ['scPpsUsr', query.scPpsUsr],
      ['issLawitmYn', query.issLawitmYn],
      ['stDt', query.stDt],
      ['edDt', query.edDt],
      ['sortCol', query.sortCol],
      ['sortOrder', query.sortOrder],
    ];
    if (query.scBlNmSct) {
      url.searchParams.set('scBlNm', 'scBlNm_blNm');
      entries.push(['scBlNmSct', query.scBlNmSct]);
    }
    for (const [key, value] of entries) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
    return url;
  }

  /**
   * Puppeteer-based fallback for NSM list page crawling.
   *
   * When the HTTP client (pal-crawl NsmLmSts) hits a Waitingroom 307 redirect,
   * it cannot execute the Waitingroom's JavaScript and will keep failing. This
   * method uses a headless browser to navigate through the Waitingroom, extract
   * the HTML, and parse it with NsmLmStsParser.
   *
   * @param query NSM search query parameters.
   * @param options Bulk-fetch options.
   * @param startPageIndex Page index to start from (pages before this are skipped).
   * @param label Label for the browser lease (e.g. 'nsm-list' or 'nsm-pending-list').
   */
  private async *fetchNsmListPagesViaBrowser(
    query: Omit<INsmSearchQuery, 'pageIndex'>,
    options: IBulkOptions | undefined,
    startPageIndex: number,
    label: string,
  ): AsyncGenerator<INsmSearchResult> {
    const parser = new NsmLmStsParser();
    const crawlOptions = {
      delayMs:
        options?.delayMs ?? APP_CONSTANTS.ARCHIVE_SYNC.NSM_CRAWLER_DELAY_MS,
      concurrency: Math.max(1, options?.concurrency ?? 1),
      maxPages: options?.maxPages,
    };

    // We need a browser session. Create a throwaway NsmLmSts to use its
    // closeBrowser() for cleanup inside runWithLease.
    const session = new NsmLmSts(this.crawlConfig);

    const allPages = await this.browserLeaseManager.runWithLease(
      `${label}-browser-fallback`,
      session,
      async () => {
        await session.initBrowser();
        const browser = session.browser;
        const page = await browser.newPage();

        try {
          const delay = crawlOptions.delayMs;
          let pageIndex = 1;
          let pagesCollected = 0;
          const results: INsmSearchResult[] = [];

          for (;;) {
            if (delay > 0 && pageIndex > 1) {
              await new Promise<void>((r) => setTimeout(r, delay));
            }

            const url = CrawlingCoreService.buildNsmListUrl({
              ...query,
              pageIndex,
            });

            const { html } = await fetchPageHtmlViaBrowser(
              page,
              url.toString(),
              { tag: `${label}-page-${pageIndex}` },
            );

            const parsed = parser.parseList(html);

            // Skip pages already yielded before the 307.
            if (pageIndex <= startPageIndex) {
              pageIndex++;
              if (
                parsed.items.length === 0 ||
                pageIndex > (parsed.totalPages ?? 1)
              )
                break;
              continue;
            }

            results.push({
              ...parsed,
              currentPage: pageIndex,
              totalPages: parsed.totalPages,
            });
            pagesCollected++;

            LoggerUtils.debugDev(
              CrawlingCoreService.name,
              `${label} browser-fallback page ${pageIndex}/${parsed.totalPages}: items=${parsed.items.length}`,
            );

            if (
              parsed.items.length === 0 ||
              pageIndex >= (parsed.totalPages ?? 1) ||
              (crawlOptions.maxPages !== undefined &&
                pagesCollected >= crawlOptions.maxPages)
            ) {
              break;
            }

            pageIndex++;
          }

          return results;
        } finally {
          await page.close();
        }
      },
    );

    for (const page of allPages) {
      yield page;
    }
  }

  /**
   * Extracts the deletion alert message from NSM detail HTML, if present.
   */
  private extractNsmDeletionAlertMessage(html: string): string | null {
    if (!html) {
      return null;
    }

    const compact = html.replace(/\s+/g, ' ');
    const alertMatch = compact.match(
      /alert\s*\(\s*['"]([^'"]*안건\s*정보가\s*없습니다\.?[^'"]*)['"]\s*\)/i,
    );
    if (alertMatch?.[1]) {
      return alertMatch[1].trim();
    }

    return null;
  }

  /**
   * Confirms whether NSM detail HTML is a deleted-bill page.
   *
   * We require BOTH:
   * 1) deletion alert text ("안건정보가 없습니다") and
   * 2) deleted-page structure (core detail wrappers are all missing)
   *
   * This avoids false positives from generic alerts unrelated to deletion.
   *
   * NOTE: The proposal-reason section can be legitimately absent in some
   * normal pages, so it is intentionally excluded from the strict threshold.
   */
  private detectNsmDeletedBillFromHtml(html: string): NsmDeletionCheck {
    if (!html) {
      return { confirmed: false, alertMessage: null };
    }

    // A page still stuck on the Waitingroom (rate-limit/anti-bot queue) is
    // never the real detail page; never let it be mistaken for a deletion.
    if (isWaitingroomHtml(html)) {
      return { confirmed: false, alertMessage: null };
    }

    const compact = html.replace(/\s+/g, ' ');
    const alertMessage = this.extractNsmDeletionAlertMessage(compact);

    const hasContainerWrap = /id\s*=\s*["']containerWrap["']/i.test(compact);
    const hasGridTable = /class\s*=\s*["'][^"']*gridCnt_table[^"']*["']/i.test(
      compact,
    );
    const hasViewForm = /name\s*=\s*["']VIEW_FM["']/i.test(compact);
    const hasSubjectTitle =
      /class\s*=\s*["'][^"']*subjectHead_tit[^"']*["']/i.test(compact);

    const coreDetailSignalCount = [
      hasContainerWrap,
      hasGridTable,
      hasViewForm,
      hasSubjectTitle,
    ].filter(Boolean).length;

    const hasHistoryBack = /history\.back\s*\(/i.test(compact);

    const looksLikeDeletedStructure =
      coreDetailSignalCount === 0 && hasHistoryBack;
    const confirmed = Boolean(alertMessage) && looksLikeDeletedStructure;

    return { confirmed, alertMessage };
  }

  /**
   * Probes the NSM detail page for a bill to see if it has been deleted.
   * Returns the deletion alert message if confirmed, or null otherwise.
   */
  async probeNsmDeletedBillAlert(billNo: string): Promise<string | null> {
    const normalized = billNo.trim();
    if (!normalized) {
      return null;
    }

    const detailUrl = buildNsmDetailUrl(normalized);

    try {
      const response = await fetchHtmlPage(detailUrl, {
        userAgent: this.crawlConfig.userAgent,
        customHeaders: this.crawlConfig.customHeaders,
        timeoutMs: 15000,
      });

      const html = response.data;
      const check = this.detectNsmDeletedBillFromHtml(html);
      if (check.confirmed) {
        return check.alertMessage;
      }

      if (check.alertMessage) {
        LoggerUtils.debugDev(
          CrawlingCoreService.name,
          `NSM deletion alert observed but structure not confirmed for bill ${normalized}`,
        );
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Derives the proposer category (제안자 구분) from the proposer name string.
   * - 위원장 -> '위원장'
   * - Contains '의원' -> '의원'
   * - Otherwise (government ministry/department name) -> '정부'
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
    const committee = item.committee?.trim() || '';
    const ministry = item.ministry?.trim() || '';
    const sourceAuthority = committee || ministry;
    const recoveredAuthority = recoverCompetentAuthorityName(sourceAuthority, {
      preferredKinds: committee
        ? ['committee', 'agency', 'ministry']
        : ['ministry', 'agency', 'committee'],
    });

    return {
      num: parseInt(item.billNo, 10),
      subject: item.billName,
      proposerCategory: CrawlingCoreService.extractProposerCategory(
        item.proposer,
      ),
      committee: recoveredAuthority,
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
   * Get the list of completed notices from the crawler.
   */
  async getDone(): Promise<ITableData[]> {
    const data = await this.createClient().getDone();
    return data ?? [];
  }

  /**
   * Get the detailed content of a completed notice by its content ID.
   */
  async getDoneContent(contentId: string): Promise<IContentData> {
    return this.createClient().getDoneContent(contentId);
  }

  /**
   * Searches for notices based on the provided query parameters.
   */
  async search(query?: ISearchQuery): Promise<ISearchResult> {
    return this.createClient().search(query);
  }

  /**
   * Searches for completed notices based on the provided query parameters.
   */
  async searchDone(query?: ISearchQuery): Promise<ISearchResult> {
    return this.createClient().searchDone(query);
  }

  /**
   * Searches for NSM bills based on the provided query parameters.
   */
  async *getAllPages(
    query?: Omit<ISearchQuery, 'pageIndex'>,
    options?: IBulkOptions,
  ): AsyncGenerator<ISearchResult> {
    yield* this.createClient().getAllPages(query, options);
  }

  /**
   * Searches for completed NSM bills based on the provided query parameters.
   */
  async *getAllDonePages(
    query?: Omit<ISearchQuery, 'pageIndex'>,
    options?: IBulkOptions,
  ): AsyncGenerator<ISearchResult> {
    yield* this.createClient().getAllDonePages(query, options);
  }

  /**
   * Wraps an async operation with Waitingroom-aware retry.
   * When a 307 redirect (Waitingroom) is detected, waits with backoff and
   * retries the operation up to MAX_WAITINGROOM_RETRIES times.
   */
  private async withWaitingroomRetry<T>(
    fn: () => Promise<T>,
    context: string,
  ): Promise<T> {
    const maxRetries = APP_CONSTANTS.CRAWLING.MAX_WAITINGROOM_RETRIES;
    const baseDelay = APP_CONSTANTS.CRAWLING.WAITINGROOM_RETRY_DELAY_MS;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (!isWaitingroomRedirectError(error) || attempt >= maxRetries) {
          throw error;
        }
        const backoffMs = baseDelay * (attempt + 1);
        LoggerUtils.debugDev(
          CrawlingCoreService.name,
          `${context}: Waitingroom redirect (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${backoffMs}ms...`,
        );
        await new Promise<void>((r) => setTimeout(r, backoffMs));
      }
    }
    // Unreachable — loop always returns or throws.
    throw new Error('unreachable');
  }

  /**
   * Fetches all pages of active NSM bills from 국민참여입법센터 (opinion.lawmaking.go.kr) via NsmLmSts.
   *
   * Includes Waitingroom redirect retry: when a 307 response is detected,
   * the client is recreated after a back-off delay and the stream restarts.
   * Callers should deduplicate by bill number (already done in crawlAllPages).
   */
  async *getAllNsmPages(
    query?: Omit<INsmSearchQuery, 'pageIndex'>,
    options?: IBulkOptions,
  ): AsyncGenerator<INsmSearchResult> {
    const maxRetries = APP_CONSTANTS.CRAWLING.MAX_WAITINGROOM_RETRIES;
    let currentPage = 0;
    let yieldedPages = 0;

    for (let wrAttempt = 0; wrAttempt <= maxRetries; wrAttempt++) {
      try {
        const client = this.createNsmClient();
        let pageIndex = 0;
        for await (const page of client.getAllPages(query, options)) {
          pageIndex++;
          currentPage = pageIndex;
          // Skip pages already yielded to avoid duplicate processing on retry.
          if (pageIndex <= yieldedPages) continue;
          yieldedPages = pageIndex;
          yield page;
        }
        return; // success — exit retry loop
      } catch (error) {
        if (!isWaitingroomRedirectError(error)) {
          throw new NsmCrawlContextError(
            error instanceof Error ? error.message : String(error),
            {
              phase: 'nsm-list',
              pageIndex: currentPage || undefined,
              cause: error,
            },
          );
        }

        // The HTTP client cannot bypass the Waitingroom (it cannot execute JS).
        // On the first Waitingroom hit, switch to a Puppeteer-based fallback
        // that can wait through the Waitingroom's JS redirect.
        this.logger.warn(
          `NSM list crawl: Waitingroom redirect on page ${currentPage} (attempt ${wrAttempt + 1}/${maxRetries + 1}), switching to browser fallback...`,
        );
        yield* this.fetchNsmListPagesViaBrowser(
          query ?? {},
          options,
          yieldedPages,
          'nsm-list',
        );
        return;
      }
    }
  }

  /**
   * Fetches all pages of active NSM bills and returns a flat array of all items.
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
        const pageItems: ITableData[] = page.items ?? [];
        for (const item of pageItems) {
          if (!seen.has(item.num)) {
            seen.add(item.num);
            allItems.push(item);
          }
        }

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
   * viewport-only (non-full-page) shot. Returns null only when every
   * strategy still exceeds the limit or an unrecoverable error occurs.
   *
   * @param contentId The content ID of the notice.
   * @param isDone When true, uses the done-notice screenshot endpoint.
   */
  async captureContentScreenshot(
    contentId: string,
    isDone = false,
  ): Promise<Buffer | null> {
    const capture = async (fullPage: boolean): Promise<Buffer> => {
      const client = new PalCrawl({
        ...this.crawlConfig,
        screenshot: { ...SCREENSHOT_CONFIG, fullPage },
      });

      return this.browserLeaseManager.runWithLease(
        `captureContentScreenshot(${contentId}, fullPage=${fullPage})`,
        client,
        async () => {
          return isDone
            ? await client.getDoneContentScreenshot(contentId)
            : await client.getContentScreenshot(contentId);
        },
      );
    };

    const maxBytes = APP_CONSTANTS.SCREENSHOT.MAX_SIZE_BYTES;

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
    const raw = await capture(true);

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

    const viewport = await capture(false);

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
    // permanent failure (content is simply too large). Return null so the
    // caller knows not to retry.
    this.logger.warn(
      `Screenshot for ${contentId} could not be reduced below ` +
        `${maxBytes} B - discarding`,
    );
    return null;
    // NOTE: Exceptions from capture / recompress are intentionally NOT
    // caught here. Transient failures propagate to the caller so that the
    // drain loop can decide whether to retry. Only the size-exceeded case
    // above returns null.
  }

  /**
   * Fetches the full detail of a single bill from 국회입법현황 (NsmLmSts).
   * Returns the parsed INsmBillDetail including proposalReason, proposalInfo,
   * session, proposer, proposalDate and attachments.
   *
   * @param billNo The 의안번호 of the bill (e.g. "2200001").
   */
  async getNsmDetail(billNo: string): Promise<INsmBillDetail> {
    try {
      return await this.withWaitingroomRetry(
        () => this.createNsmClient().getDetail(billNo),
        `NSM detail bill ${billNo}`,
      );
    } catch (error) {
      if (!isWaitingroomRedirectError(error)) {
        throw error;
      }

      // HTTP client cannot bypass Waitingroom — fall back to Puppeteer.
      this.logger.warn(
        `NSM detail bill ${billNo}: Waitingroom 307 after HTTP retries, switching to browser fallback`,
      );

      return this.fetchNsmDetailViaBrowser(billNo);
    }
  }

  /**
   * Puppeteer-based fallback for fetching a single NSM bill detail page.
   * Used when the HTTP client hits a Waitingroom 307.
   */
  private async fetchNsmDetailViaBrowser(
    billNo: string,
  ): Promise<INsmBillDetail> {
    const normalized = billNo.trim();
    const detailUrl = buildNsmDetailUrl(normalized);
    const parser = new NsmLmStsParser();

    const session = new NsmLmSts(this.crawlConfig);

    return this.browserLeaseManager.runWithLease(
      `getNsmDetail(${normalized})-browser-fallback`,
      session,
      async () => {
        await session.initBrowser();
        const browser = session.browser;
        const page = await browser.newPage();

        try {
          const { html } = await fetchPageHtmlViaBrowser(page, detailUrl, {
            tag: `bill ${normalized}`,
          });
          return parser.parseDetail(html);
        } finally {
          await page.close();
        }
      },
    );
  }

  /**
   * Async generator that yields every page of pending ("발의" status) bills
   * from 국민참여입법센터 (opinion.lawmaking.go.kr) via NsmLmSts.
   *
   * Pending bills are those proposed in the National Assembly but not yet
   * referred to a standing committee. Streaming them here lets the system
   * detect new legislation well before the formal 입법예고 process begins.
   *
   * Includes Waitingroom redirect retry (same strategy as getAllNsmPages).
   *
   * @param query Optional NsmLmSts search filters (pageIndex is managed internally).
   * @param options Bulk-fetch options (delayMs, concurrency, maxPages).
   */
  async *getAllNsmPendingPages(
    query?: Omit<INsmSearchQuery, 'pageIndex'>,
    options?: IBulkOptions,
  ): AsyncGenerator<INsmSearchResult> {
    const maxRetries = APP_CONSTANTS.CRAWLING.MAX_WAITINGROOM_RETRIES;
    let currentPage = 0;
    let yieldedPages = 0;

    for (let wrAttempt = 0; wrAttempt <= maxRetries; wrAttempt++) {
      try {
        const client = this.createNsmClient();
        let pageIndex = 0;
        for await (const page of client.getAllPendingPages(query, options)) {
          pageIndex++;
          currentPage = pageIndex;
          if (pageIndex <= yieldedPages) continue;
          yieldedPages = pageIndex;
          yield page;
        }
        return; // success — exit retry loop
      } catch (error) {
        if (!isWaitingroomRedirectError(error)) {
          throw new NsmCrawlContextError(
            error instanceof Error ? error.message : String(error),
            {
              phase: 'nsm-pending-list',
              pageIndex: currentPage || undefined,
              cause: error,
            },
          );
        }

        this.logger.warn(
          `NSM pending crawl: Waitingroom redirect on page ${currentPage} (attempt ${wrAttempt + 1}/${maxRetries + 1}), switching to browser fallback...`,
        );
        yield* this.fetchNsmListPagesViaBrowser(
          { ...query, rslRsltNmL: '900101' } as Omit<
            INsmSearchQuery,
            'pageIndex'
          >,
          options,
          yieldedPages,
          'nsm-pending-list',
        );
        return;
      }
    }
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
  async captureNsmDetailFull(billNo: string): Promise<{
    html: string;
    screenshot: Buffer | null;
    detail: INsmBillDetail | null;
    responseUrl: string;
    statusCode: number;
  }> {
    const normalized = billNo.trim();
    if (!normalized) throw new Error('billNo is required');

    const client = new NsmLmSts({
      ...this.crawlConfig,
      screenshot: SCREENSHOT_CONFIG,
    });

    return this.browserLeaseManager.runWithLease(
      `captureNsmDetailFull(${normalized})`,
      client,
      async () => {
        const detailUrl = buildNsmDetailUrl(normalized);
        const maxBytes = APP_CONSTANTS.SCREENSHOT.MAX_SIZE_BYTES;

        await client.initBrowser();
        const browser = client.browser;
        const page = await browser.newPage();

        try {
          await page.setViewport({
            width: APP_CONSTANTS.SCREENSHOT.WIDTH,
            height: APP_CONSTANTS.SCREENSHOT.HEIGHT,
          });

          // ── Navigate with Waitingroom bypass ──────────────────────────────
          const { response } = await navigateWithWaitingroomBypass(
            page,
            detailUrl,
            { tag: `bill ${billNo}` },
          );

          // If the Waitingroom retry budget was exhausted, this is not the
          // real detail page — bail out before any deletion check or parsing
          // can run against it.
          if (await isWaitingroomPage(page)) {
            throw new NsmWaitingroomUnresolvedError(billNo);
          }

          const html = await page.content();
          const responseUrl = page.url();
          const statusCode = response?.status() ?? 200;

          const deletionCheck = this.detectNsmDeletedBillFromHtml(html);
          if (deletionCheck.confirmed && deletionCheck.alertMessage) {
            throw new NsmBillDeletedError(billNo, deletionCheck.alertMessage, {
              responseUrl,
            });
          }

          if (deletionCheck.alertMessage) {
            LoggerUtils.debugDev(
              CrawlingCoreService.name,
              `NSM bill ${billNo}: deletion alert present but not structurally confirmed`,
            );
          }

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
      },
    );
  }

  /**
   * Captures a full-page JPEG screenshot of a NSM bill detail page.
   * Used by the screenshot backfill queue for bills whose screenshot is still
   * missing after the initial archive (e.g. when captureNsmDetailFull failed).
   *
   * @param billNo 의안번호 (e.g. "2200001")
   */
  async captureNsmDetailScreenshot(billNo: string): Promise<Buffer | null> {
    const client = new NsmLmSts({
      ...this.crawlConfig,
      screenshot: SCREENSHOT_CONFIG,
    });

    return this.browserLeaseManager.runWithLease(
      `captureNsmDetailScreenshot(${billNo})`,
      client,
      async () => {
        const maxBytes = APP_CONSTANTS.SCREENSHOT.MAX_SIZE_BYTES;

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
      },
    );
  }
}
