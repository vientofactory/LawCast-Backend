import { Injectable } from '@nestjs/common';
import {
  LikmsCrawler,
  LikmsNsmAdapter,
  NsmLmSts,
  NsmLmStsParser,
  PalCrawl,
  type IBulkOptions,
  type IContentData,
  type INsmBillDetail,
  type INsmBillItem,
  type INsmDetailCrawler,
  type INsmListCrawler,
  type ISearchQuery,
  type ISearchResult,
  type INsmSearchQuery,
  type INsmSearchResult,
  type ITableData,
  type LikmsStateCrawlerConfig,
  type PalCrawlConfig,
} from 'pal-crawl';
import { URL } from 'node:url';
import sharp from 'sharp';
import { APP_CONSTANTS } from '../../config/app.config';
import { type CachedNotice } from '../../types/cache.types';
import { fetchHtmlPage } from '../../utils/http-fetch.utils';
import {
  createCrawlerClientHeaders,
  createCrawlerFetchHeaders,
} from '../../utils/browser-request-headers.util';
import { LoggerUtils } from '../../utils/logger.utils';
import { isNsmDeletionDetectionEnabled } from '../../utils/source-deletion-detection.utils';
import {
  isLikmsNsmSourceEnabled,
  isNsmCrawlerEnabled,
  isPalCrawlerEnabled,
} from '../../utils/crawler-activation.utils';
import { BrowserLeaseManagerService } from './browser-lease-manager.service';
import { recoverCompetentAuthorityName } from './utils/competent-authority-autocomplete.utils';
import {
  navigateWithWaitingroomBypass,
  fetchPageHtmlViaBrowser,
  isWaitingroomRedirectError,
  isWaitingroomPage,
  isWaitingroomHtml,
} from './utils/waitingroom-bypass';
import { isNsmPortalErrorPageHtml } from './utils/nsm-portal-error-page.util';
import { AI_SUMMARY_STATUS } from './utils/ai-summary-status.utils';

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

/**
 * The pending-list port shared by `NsmLmSts` and `LikmsNsmAdapter`.
 *
 * pal-crawl deliberately keeps `searchPending`/`getAllPendingPages` out of
 * `INsmListCrawler`: NSM narrows server-side (`rslRsltNmL=900101`), while LIKMS
 * has no equivalent filter and must scan pages, so hiding the cost behind the
 * same interface would misrepresent it. Both implementations expose the method
 * with the same shape, which is what this local port captures.
 */
type NsmPendingListCrawler = {
  getAllPendingPages(
    query?: Omit<INsmSearchQuery, 'pageIndex'>,
    options?: IBulkOptions,
  ): AsyncGenerator<INsmSearchResult>;
};

/**
 * The NSM-shaped list/detail client used by the crawling pipeline.
 *
 * `NsmLmSts` (`국민참여입법센터`) satisfies the ports structurally;
 * `LikmsNsmAdapter` (`국회 의안정보시스템` `계류의안`) implements them explicitly.
 * Selecting between
 * the two therefore needs no change at any call site — every consumer keeps
 * working against the same `INsmBillItem`/`INsmSearchResult` shapes.
 */
type NsmCrawlerClient = INsmListCrawler &
  INsmDetailCrawler &
  NsmPendingListCrawler;

/** JPEG quality levels tried in order when the full-page capture is too large. */
const SCREENSHOT_FALLBACK_QUALITIES =
  APP_CONSTANTS.SCREENSHOT.FALLBACK_QUALITIES;

/**
 * Progress-status values that mean "filed but not yet referred to a standing
 * committee": NSM (`rslRsltNmL=900101`) reports `발의`, while the LIKMS adapter
 * reports the assembly-system word `접수` for the same stage.
 */
const PENDING_PROGRESS_STATUSES = new Set(['발의', '접수']);

type NsmDeletionCheck = {
  confirmed: boolean;
  alertMessage: string | null;
};

/**
 * Outcome of one NSM detail-page deletion probe.
 *
 * - `deleted`: the real detail page confirmed the deletion alert.
 * - `alive`: the real detail page was read and the bill is still listed.
 * - `blocked`: the portal answered with its own error page or the Waitingroom,
 *   so the response says nothing about the bill. Callers must not treat this
 *   as "alive" for logging or throttling purposes: it is a read failure.
 * - `error`: the request failed (timeout, connection, DNS).
 * - `disabled`: the NSM crawler or deletion detection is off, so no request
 *   was issued.
 */
export type NsmDeletionProbeOutcome =
  'deleted' | 'alive' | 'blocked' | 'error' | 'disabled';

export type NsmDeletionProbeResult = {
  outcome: NsmDeletionProbeOutcome;
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

/**
 * The likms (`국회 의안정보시스템`) bill detail page for a resolved `billId`
 * (`PRC_...`). {@link buildNsmDetailUrl} is the `국민참여입법센터` equivalent.
 *
 * Detail capture must open the page of whichever portal the list came from: an
 * `의안번호` that only likms knows has no NSM detail page, and asking NSM for it
 * returns its own error template rather than the bill.
 *
 * Mirrors pal-crawl's `LikmsCrawler.buildDetailPageUrl` (which is private),
 * matching how {@link buildNsmDetailUrl} mirrors `NsmLmSts.buildListUrl`.
 */
export function buildLikmsBillDetailUrl(billId: string): string {
  return `https://likms.assembly.go.kr/bill/bi/billDetailPage.do?billId=${billId.trim()}&currMenuNo=2600044`;
}

/**
 * Page a notice's snapshot and its screenshot must be captured from.
 *
 * The screenshot is not a separate sourcing decision: it is the image of the
 * archived page, so it has to come from exactly the portal the snapshot came
 * from. Capturing the snapshot through likms and the image through
 * `국민참여입법센터` stores two different pages for one notice - the NSM portal
 * answers a likms-listed bill with its own error template, so the stored image
 * shows `안건정보가 없습니다` instead of the bill.
 *
 * With `CRAWLING_NSM_SOURCE=likms` the source is therefore likms and **only**
 * likms: a bill likms cannot resolve yields `null` (no capture at all) rather
 * than a fallback to the other portal. The NSM portal applies only when it is
 * the active list source.
 */
export type SnapshotCaptureSource = 'likms' | 'nsm';

export interface SnapshotCaptureTarget {
  source: SnapshotCaptureSource;
  /** The page the snapshot and the screenshot are both taken from. */
  url: string;
}

/** Portal each snapshot source serves its pages from. */
const SNAPSHOT_SOURCE_HOST: Record<SnapshotCaptureSource, string> = {
  likms: 'likms.assembly.go.kr',
  nsm: 'opinion.lawmaking.go.kr',
};

/**
 * Whether the page a capture landed on really belongs to the source's own
 * portal.
 *
 * A browser navigation can end somewhere else than the URL that was opened:
 * a portal-side redirect, an interstitial, an anti-bot bounce. Storing that
 * page as the snapshot - and its image as the screenshot - is the defect this
 * check closes: the likms path once stored `국민참여입법센터`'s 404 shell for
 * every bill it listed, so the archived "original" and its screenshot belonged
 * to a portal that never served the bill.
 */
export function isSnapshotSourcePageUrl(
  url: string,
  source: SnapshotCaptureSource,
): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const expected = SNAPSHOT_SOURCE_HOST[source];

    return hostname === expected || hostname.endsWith(`.${expected}`);
  } catch {
    return false;
  }
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
    // Identity fields are deliberately absent: every client is built through
    // `buildClientConfig()` so it gets its own browser identity instead of one
    // shared by the process (see `createCrawlerClientHeaders`).
    this.crawlConfig = {
      timeout: APP_CONSTANTS.CRAWLING.TIMEOUT,
      retryCount: APP_CONSTANTS.CRAWLING.RETRY_COUNT,
      hydrateTruncatedTitles:
        APP_CONSTANTS.CRAWLING.NSM_HYDRATE_TRUNCATED_TITLES,
      // pal-crawl >= 2.2.0 fills an empty proposalReason from the National
      // Assembly Bill Information System (likms) inside
      // getContent/getDoneContent. Kept explicit so PAL collection never
      // silently loses its hydration path.
      hydrateProposalReason: true,
    };
  }

  /**
   * True while a browser session is open anywhere in the process.
   *
   * Exposes the lease manager's cheap counter so schedulers can decide whether
   * to start browser work without paying for `getDebugState()`'s process scan.
   * Every browser operation funnels through `runWithLease`, so this is the
   * accurate contention signal for the shared browser resource — unlike
   * "is any background task registered", which counts non-browser follow-up
   * work (apply drains, integrity scans) and starves browser backfills.
   */
  isBrowserLeaseActive(): boolean {
    return this.browserLeaseManager.hasActiveLease();
  }

  /**
   * Builds a pal-crawl client config carrying a real browser identity.
   *
   * One config is built per client, and pal-crawl keeps it for the client's
   * whole lifetime, so a crawl operation rotates the User-Agent per request
   * while presenting one browser family for the operation (see
   * `createCrawlerClientHeaders`). Either way the headers describe the same
   * browser as the User-Agent, which is what stops a portal from sorting these
   * requests out by header shape.
   */
  private buildClientConfig(
    extra: Partial<NsmCrawlConfig> = {},
  ): NsmCrawlConfig {
    const { userAgent, customHeaders } = createCrawlerClientHeaders();

    return {
      ...this.crawlConfig,
      userAgent,
      customHeaders,
      ...extra,
    };
  }

  private createClient(): PalCrawl {
    return new PalCrawl(this.buildClientConfig());
  }

  /**
   * Builds the NSM-shaped list/detail client for the current source.
   *
   * Default: `NsmLmSts` (`국민참여입법센터` `입법진행현황`).
   * With `CRAWLING_NSM_SOURCE=likms`: pal-crawl's `LikmsNsmAdapter`, which serves
   * the National Assembly Bill Information System (`국회 의안정보시스템` `계류의안`)
   * through the same NSM ports so the existing
   * list -> `nsmBillToCachedNotice` -> archive/cache/notification pipeline runs
   * unchanged.
   *
   * The LIKMS config intentionally omits `hydrateProposalReason`: the pipeline
   * backfills proposal reasons through its own retry paths, and per-item
   * hydration would add two requests per bill to every bulk list scan.
   */
  private createNsmClient(): NsmCrawlerClient {
    if (isLikmsNsmSourceEnabled()) {
      const clientConfig = this.buildClientConfig();
      const likmsConfig: LikmsStateCrawlerConfig = {
        userAgent: clientConfig.userAgent,
        timeout: clientConfig.timeout,
        retryCount: clientConfig.retryCount,
        customHeaders: clientConfig.customHeaders,
      };

      return new LikmsNsmAdapter(likmsConfig);
    }

    return new NsmLmSts(this.buildClientConfig());
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
    const session = new NsmLmSts(this.buildClientConfig());

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
   *
   * Thin wrapper over `probeNsmDeletedBillOutcome` kept for callers that only
   * need the confirmed deletion signal (and for the pre-existing contract that
   * "anything other than a confirmed deletion is null"). Prefer the outcome
   * variant when the caller also logs or throttles on the probe result, so a
   * blocked/unreadable response is not reported as a live bill.
   */
  async probeNsmDeletedBillAlert(billNo: string): Promise<string | null> {
    const { outcome, alertMessage } =
      await this.probeNsmDeletedBillOutcome(billNo);
    return outcome === 'deleted' ? alertMessage : null;
  }

  /**
   * Probes the NSM detail page and reports *why* no deletion was confirmed.
   *
   * The portal answers refused requests (blacklisted User-Agent, removed path,
   * anti-bot/session rejection) with its own error page at HTTP 200, and it
   * answers rate-limited requests with the Waitingroom. Neither response is the
   * bill's detail page, so both are reported as `blocked` instead of `alive` —
   * callers can then stop a batch early and say so in the logs, instead of
   * silently retrying the whole candidate set every cycle. A confirmed deletion
   * still requires BOTH the deletion alert text and the deleted-page structure
   * (see `detectNsmDeletedBillFromHtml`).
   */
  async probeNsmDeletedBillOutcome(
    billNo: string,
  ): Promise<NsmDeletionProbeResult> {
    // A disabled NSM crawler never issues the probe request at all: callers
    // treat anything but `deleted` as "not confirmed" and therefore never mark
    // source_deleted.
    if (!isNsmCrawlerEnabled()) {
      return { outcome: 'disabled', alertMessage: null };
    }

    // Runtime kill switch (CRAWLING_NSM_DELETION_DETECTION_ENABLED): when
    // deletion detection is disabled, never issue the probe request.
    if (!isNsmDeletionDetectionEnabled()) {
      return { outcome: 'disabled', alertMessage: null };
    }

    const normalized = billNo.trim();
    if (!normalized) {
      return { outcome: 'error', alertMessage: null };
    }

    const detailUrl = buildNsmDetailUrl(normalized);

    try {
      // A fresh identity per probe: unlike the pal-crawl clients, this call
      // builds its whole header object, so the family can rotate too.
      const { userAgent, customHeaders } = createCrawlerFetchHeaders();
      const response = await fetchHtmlPage(detailUrl, {
        userAgent,
        customHeaders,
        timeoutMs: 15000,
      });

      const html = response.data;

      if (isNsmPortalErrorPageHtml(html) || isWaitingroomHtml(html)) {
        return { outcome: 'blocked', alertMessage: null };
      }

      const check = this.detectNsmDeletedBillFromHtml(html);
      if (check.confirmed) {
        return { outcome: 'deleted', alertMessage: check.alertMessage };
      }

      if (check.alertMessage) {
        LoggerUtils.debugDev(
          CrawlingCoreService.name,
          `NSM deletion alert observed but structure not confirmed for bill ${normalized}`,
        );
      }
      return { outcome: 'alive', alertMessage: null };
    } catch {
      return { outcome: 'error', alertMessage: null };
    }
  }

  /**
   * Whether an item's progress status marks it as pending-like (filed but not
   * yet referred to a standing committee). Shared by the NSM and LIKMS sources
   * so both classify pending bills identically.
   */
  static isPendingProgressStatus(
    progressStatus: string | null | undefined,
  ): boolean {
    return PENDING_PROGRESS_STATUSES.has(progressStatus?.trim() ?? '');
  }

  /**
   * Whether an NSM-shaped list item can enter the notice pipeline.
   *
   * The pipeline addresses notices by their numeric `의안번호` (`num`): archive
   * rows, diffchain events, cache keys and notifications all key on it. The
   * LIKMS `계류의안` list also carries non-bill items (for example an
   * `인사청문요청안` whose `billNo` is `ZZ22142`), which have no numeric id and
   * must be dropped before mapping instead of being archived as `num=NaN`.
   */
  static isCrawlableNsmBill(item: INsmBillItem): boolean {
    const parsed = Number.parseInt(item.billNo?.trim() ?? '', 10);
    return Number.isInteger(parsed) && parsed > 0;
  }

  /**
   * Derives the proposer category from the proposer name string:
   * - Contains the committee-chair title -> '위원장'
   * - Contains the Assembly-member title -> '의원'
   * - Otherwise (a government ministry/department name) -> '정부'
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
   * Bills returned by NsmLmSts are in "proposed" state and do not yet have a
   * pal.assembly.go.kr contentId. The `committee` field from the list page is
   * empty until the bill is referred to a standing committee, so `ministry`
   * (the competent-ministry field) is used as a fallback to preserve
   * competent-authority information.
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
      aiSummaryStatus: AI_SUMMARY_STATUS.NOT_REQUESTED,
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
   * Fetches only the proposal-reason section ("제안이유 및 주요내용") of a PAL
   * notice from the National Assembly Bill Information System
   * (likms.assembly.go.kr) via pal-crawl's LikmsCrawler.
   *
   * A PAL contentId (`PRC_...`) doubles as the likms billId, so no bill-number
   * lookup is needed. The crawler never throws: any network/parse failure
   * resolves to null, which callers must treat as "still no reason".
   *
   * Used by the proposalReason backfill cron, where a browser session per
   * notice would be far too expensive.
   *
   * @param contentId The pal.assembly.go.kr contentId of the notice.
   */
  async getProposalReasonViaLikms(contentId: string): Promise<string | null> {
    const normalized = contentId.trim();
    if (!normalized) {
      return null;
    }

    const { userAgent, customHeaders } = createCrawlerClientHeaders();
    const client = new LikmsCrawler({
      userAgent,
      timeout: this.crawlConfig.timeout,
      retryCount: this.crawlConfig.retryCount,
      customHeaders,
    });

    return client.getProposalReason(normalized);
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
    // Disabled PAL crawler: yield no pages so full sync, the hot-path cron
    // crawl and the NSM->PAL refresh never collect data (and therefore never
    // reach the archive snapshot / diffchain paths).
    if (!isPalCrawlerEnabled()) {
      LoggerUtils.debugDev(
        CrawlingCoreService.name,
        'PAL crawler disabled (CRAWLING_PAL_ENABLED); skipping PAL list crawl',
      );
      return;
    }

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
   * Fetches all pages of active NSM bills from the National Assembly
   * public-participation portal (opinion.lawmaking.go.kr) via NsmLmSts.
   *
   * Includes Waitingroom redirect retry: when a 307 response is detected,
   * the client is recreated after a back-off delay and the stream restarts.
   * Callers should deduplicate by bill number (already done in crawlAllPages).
   */
  async *getAllNsmPages(
    query?: Omit<INsmSearchQuery, 'pageIndex'>,
    options?: IBulkOptions,
  ): AsyncGenerator<INsmSearchResult> {
    // Disabled NSM crawler: yield no pages so pending sync and the pending
    // cron never collect NSM data or reach snapshot/change-tracking paths.
    if (!isNsmCrawlerEnabled()) {
      LoggerUtils.debugDev(
        CrawlingCoreService.name,
        'NSM crawler disabled (CRAWLING_NSM_ENABLED); skipping NSM list crawl',
      );
      return;
    }

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
        ...this.buildClientConfig(),
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
   * Fetches the full detail of a single bill from the legislation-status site
   * (NsmLmSts).
   * Returns the parsed INsmBillDetail including proposalReason, proposalInfo,
   * session, proposer, proposalDate and attachments.
   *
   * @param billNo The assembly bill number (e.g. "2200001").
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
    // The fallback page follows the active source too: opening the NSM URL for
    // a likms-listed bill would parse the NSM error template as if it were the
    // bill.
    const target = await this.resolveSnapshotCaptureTarget(normalized);
    if (!target) {
      throw new Error(`likms has no detail page for bill ${normalized}`);
    }
    const detailUrl = target.url;
    const parser = new NsmLmStsParser();

    const session = new NsmLmSts(this.buildClientConfig());

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
   * Async generator that yields every page of pending ("proposed" status)
   * bills from the National Assembly public-participation portal
   * (opinion.lawmaking.go.kr) via NsmLmSts.
   *
   * Pending bills are those proposed in the National Assembly but not yet
   * referred to a standing committee. Streaming them here lets the system
   * detect new legislation well before the formal legislative-notice process
   * ("입법예고") begins.
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
    // Disabled NSM crawler: yield no pages (see getAllNsmPages).
    if (!isNsmCrawlerEnabled()) {
      LoggerUtils.debugDev(
        CrawlingCoreService.name,
        'NSM crawler disabled (CRAWLING_NSM_ENABLED); skipping NSM pending list crawl',
      );
      return;
    }

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
   * Captures a bill's detail page, its screenshot and its parsed fields in one
   * browser session.
   *
   * The page follows the **active list source**, so the snapshot and the
   * screenshot it returns always come from the portal that listed the bill:
   * `국회 의안정보시스템` (`likms`) with `CRAWLING_NSM_SOURCE=likms`,
   * `국민참여입법센터` (`NsmLmSts`) otherwise. Capturing a likms-listed bill
   * through the NSM URL stores the NSM error page with no `제안이유`, which is
   * why the two paths are separate and why there is no cross-portal fallback.
   *
   * Used for pending bills that do not yet have a pal.assembly.go.kr contentId.
   * Applies the same JPEG recompression pipeline as `captureContentScreenshot`
   * to keep screenshots within the configured size limit.
   *
   * @param billNo The assembly bill number (e.g. "2200001").
   */
  async captureNsmDetailFull(billNo: string): Promise<{
    html: string;
    screenshot: Buffer | null;
    detail: INsmBillDetail | null;
    /** The page the snapshot and the screenshot were both taken from. */
    requestUrl: string;
    responseUrl: string;
    statusCode: number;
  }> {
    const normalized = billNo.trim();
    if (!normalized) throw new Error('billNo is required');

    return isLikmsNsmSourceEnabled()
      ? this.captureLikmsDetailFull(normalized)
      : this.captureNsmPortalDetailFull(normalized);
  }

  /**
   * Captures a likms (`국회 의안정보시스템`) bill detail page.
   *
   * The detail page is keyed on likms's own `billId` (`PRC_...`) rather than
   * the `의안번호` the pipeline carries, so the id is resolved first. Parsed
   * fields come from the list-source adapter: its `getDetail` reads the
   * `심사정보` fragment, which is the only place `제안이유 및 주요내용` lives.
   *
   * @param billNo The assembly bill number (e.g. "2221891").
   */
  private async captureLikmsDetailFull(billNo: string): Promise<{
    html: string;
    screenshot: Buffer | null;
    detail: INsmBillDetail | null;
    requestUrl: string;
    responseUrl: string;
    statusCode: number;
  }> {
    const detailUrl = await this.resolveLikmsDetailUrl(billNo);
    if (!detailUrl) {
      throw new Error(`likms has no detail page for bill ${billNo}`);
    }

    // No Waitingroom and no NSM deletion heuristic here: those belong to the
    // NSM portal, and its HTML vocabulary does not describe likms pages.
    const detail = await this.createNsmClient().getDetail(billNo);

    const session = new NsmLmSts({
      ...this.buildClientConfig(),
      screenshot: SCREENSHOT_CONFIG,
    });

    return this.browserLeaseManager.runWithLease(
      `captureNsmDetailFull(${billNo})`,
      session,
      async () => {
        await session.initBrowser();
        const browser = session.browser;
        const page = await browser.newPage();

        try {
          await page.setViewport({
            width: APP_CONSTANTS.SCREENSHOT.WIDTH,
            height: APP_CONSTANTS.SCREENSHOT.HEIGHT,
          });

          const response = await page.goto(detailUrl, {
            waitUntil: 'domcontentloaded',
            timeout: APP_CONSTANTS.CRAWLING.WAITINGROOM_GOTO_TIMEOUT_MS,
          });

          // The `심사정보` panels are filled over AJAX after the shell
          // loads, so let the network settle before capturing. A timeout is
          // not fatal: we still store whatever finished rendering.
          await page
            .waitForNetworkIdle({ idleTime: 500, timeout: 15000 })
            .catch(() => undefined);

          const html = await page.content();
          const responseUrl = page.url();
          const statusCode = response?.status() ?? 200;

          // The screenshot is the image of the archived page, so the capture
          // is only valid when it really is the likms detail page. A page that
          // landed elsewhere is refused here instead of being stored as this
          // notice's snapshot and screenshot.
          if (!isSnapshotSourcePageUrl(responseUrl, 'likms')) {
            throw new Error(
              `likms capture for bill ${billNo} landed on ${responseUrl} - refusing to store a foreign page`,
            );
          }

          let screenshot: Buffer | null = null;
          try {
            const raw = await page.screenshot({
              fullPage: true,
              type: 'jpeg',
              quality: APP_CONSTANTS.SCREENSHOT.QUALITY,
            });
            screenshot = await this.fitScreenshotWithinSizeLimit(
              Buffer.from(raw),
              `likms screenshot for bill ${billNo}`,
            );
            if (screenshot) {
              // The captured page is part of the record: an operator verifying
              // that a snapshot and its screenshot come from the same portal
              // reads it here instead of opening the stored image.
              this.logger.log(
                `likms screenshot captured for bill ${billNo} (${screenshot.length}B from ${detailUrl})`,
              );
            }
          } catch (err) {
            this.logger.warn(
              `likms screenshot capture failed for bill ${billNo}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }

          return {
            html,
            screenshot,
            detail,
            requestUrl: detailUrl,
            responseUrl,
            statusCode,
          };
        } finally {
          await page.close();
        }
      },
    );
  }

  /**
   * Resolves the page a notice's snapshot **and** its screenshot must be taken
   * from, for the active list source.
   *
   * Returns `null` when the active source cannot serve the bill at all: with
   * `CRAWLING_NSM_SOURCE=likms` a bill likms does not publish yields `null`
   * instead of an NSM URL, because the NSM portal answers it with its own error
   * template - storing that as the snapshot (and screenshot) is the defect this
   * resolver exists to prevent.
   *
   * Callers that capture the page themselves should open exactly this URL; the
   * archive's `httpMetadata.requestUrl` should record it too, so the stored row
   * describes the portal it really came from.
   *
   * @param billNo The assembly bill number (e.g. "2200001") or a `PRC_...` id.
   */
  async resolveSnapshotCaptureTarget(
    billNo: string,
  ): Promise<SnapshotCaptureTarget | null> {
    const normalized = billNo.trim();
    if (!normalized) {
      return null;
    }

    if (isLikmsNsmSourceEnabled()) {
      const detailUrl = await this.resolveLikmsDetailUrl(normalized);
      return detailUrl ? { source: 'likms', url: detailUrl } : null;
    }

    return { source: 'nsm', url: buildNsmDetailUrl(normalized) };
  }

  /**
   * Resolves the likms bill detail URL for a bill number.
   *
   * A `billId` (`PRC_...`) is used as-is; an `의안번호` is resolved through
   * pal-crawl's likms crawler. Returns null when likms has no such bill.
   */
  private async resolveLikmsDetailUrl(billNo: string): Promise<string | null> {
    const normalized = billNo.trim();
    if (!normalized) return null;

    if (normalized.startsWith('PRC_')) {
      return buildLikmsBillDetailUrl(normalized);
    }

    const { userAgent, customHeaders } = createCrawlerClientHeaders();
    const crawler = new LikmsCrawler({
      userAgent,
      timeout: this.crawlConfig.timeout,
      retryCount: this.crawlConfig.retryCount,
      customHeaders,
    });

    const billId = await crawler.resolveBillId(normalized);
    return billId ? buildLikmsBillDetailUrl(billId) : null;
  }

  /**
   * Shrinks a captured screenshot below the archive size limit by re-encoding
   * it at successive fallback qualities. Returns null when even the lowest
   * quality stays above the limit.
   */
  private async fitScreenshotWithinSizeLimit(
    raw: Buffer,
    label: string,
  ): Promise<Buffer | null> {
    const maxBytes = APP_CONSTANTS.SCREENSHOT.MAX_SIZE_BYTES;
    if (raw.length <= maxBytes) {
      return raw;
    }

    for (const quality of SCREENSHOT_FALLBACK_QUALITIES) {
      const recompressed = await sharp(raw).jpeg({ quality }).toBuffer();
      if (recompressed.length <= maxBytes) {
        return recompressed;
      }
    }

    this.logger.warn(
      `${label} could not be reduced below ${maxBytes}B - discarding`,
    );
    return null;
  }

  /**
   * Captures an NSM (`국민참여입법센터`) bill detail page with Waitingroom
   * bypass and the NSM deletion heuristic. {@link captureNsmDetailFull}
   * dispatches here when the active source is NSM.
   */
  private async captureNsmPortalDetailFull(billNo: string): Promise<{
    html: string;
    screenshot: Buffer | null;
    detail: INsmBillDetail | null;
    requestUrl: string;
    responseUrl: string;
    statusCode: number;
  }> {
    const normalized = billNo.trim();
    if (!normalized) throw new Error('billNo is required');

    const client = new NsmLmSts({
      ...this.buildClientConfig(),
      screenshot: SCREENSHOT_CONFIG,
    });

    return this.browserLeaseManager.runWithLease(
      `captureNsmDetailFull(${normalized})`,
      client,
      async () => {
        const detailUrl = buildNsmDetailUrl(normalized);

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

            // pal-crawl >= 2.2.0 ships puppeteer 25, whose screenshot() is
            // typed as Uint8Array — copy into a Buffer for downstream callers.
            screenshot = await this.fitScreenshotWithinSizeLimit(
              Buffer.from(raw),
              `NSM screenshot for bill ${billNo}`,
            );
            if (screenshot) {
              this.logger.log(
                `NSM screenshot captured for bill ${billNo} (${screenshot.length}B from ${detailUrl})`,
              );
            }
          } catch (err) {
            this.logger.warn(
              `NSM screenshot capture failed for bill ${billNo}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }

          return {
            html,
            screenshot,
            detail,
            requestUrl: detailUrl,
            responseUrl,
            statusCode,
          };
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
   * @param billNo The assembly bill number (e.g. "2200001")
   */
  async captureNsmDetailScreenshot(billNo: string): Promise<Buffer | null> {
    // With `CRAWLING_NSM_SOURCE=likms` the image comes from the likms detail
    // page - the same page the snapshot came from - with our own browser
    // session, so it does not depend on the NSM crawler being enabled: that
    // flag gates `국민참여입법센터` collection, not this capture.
    if (isLikmsNsmSourceEnabled()) {
      return this.captureLikmsDetailScreenshot(billNo);
    }

    // NSM portal source: a disabled crawler must not open a browser for it.
    if (!isNsmCrawlerEnabled()) {
      return null;
    }

    const client = new NsmLmSts({
      ...this.buildClientConfig(),
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

  /**
   * Captures a likms (`국회 의안정보시스템`) bill detail page screenshot for
   * the backfill queue. Mirrors {@link captureNsmDetailScreenshot}'s contract
   * but opens the likms page, so the stored snapshot belongs to the portal that
   * listed the bill.
   */
  private async captureLikmsDetailScreenshot(
    billNo: string,
  ): Promise<Buffer | null> {
    const detailUrl = await this.resolveLikmsDetailUrl(billNo);
    if (!detailUrl) {
      this.logger.warn(
        `likms has no detail page for bill ${billNo} - skipping screenshot`,
      );
      return null;
    }

    const session = new NsmLmSts({
      ...this.buildClientConfig(),
      screenshot: SCREENSHOT_CONFIG,
    });

    return this.browserLeaseManager.runWithLease(
      `captureNsmDetailScreenshot(${billNo})`,
      session,
      async () => {
        await session.initBrowser();
        const browser = session.browser;
        const page = await browser.newPage();

        try {
          await page.setViewport({
            width: APP_CONSTANTS.SCREENSHOT.WIDTH,
            height: APP_CONSTANTS.SCREENSHOT.HEIGHT,
          });

          await page.goto(detailUrl, {
            waitUntil: 'domcontentloaded',
            timeout: APP_CONSTANTS.CRAWLING.WAITINGROOM_GOTO_TIMEOUT_MS,
          });
          await page
            .waitForNetworkIdle({ idleTime: 500, timeout: 15000 })
            .catch(() => undefined);

          // Never store an image of a page the bill does not live on: the
          // likms source is unconditional, so a capture that landed elsewhere
          // yields no screenshot at all rather than a foreign portal's page.
          const landedUrl = page.url();
          if (!isSnapshotSourcePageUrl(landedUrl, 'likms')) {
            this.logger.warn(
              `likms screenshot for bill ${billNo} landed on ${landedUrl} - discarding`,
            );
            return null;
          }

          const raw = await page.screenshot({
            fullPage: true,
            type: 'jpeg',
            quality: APP_CONSTANTS.SCREENSHOT.QUALITY,
          });

          return this.fitScreenshotWithinSizeLimit(
            Buffer.from(raw),
            `likms screenshot for bill ${billNo}`,
          );
        } finally {
          await page.close();
        }
      },
    );
  }
}
