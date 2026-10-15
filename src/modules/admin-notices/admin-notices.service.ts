import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  APIResponseError,
  Client,
  isHTTPResponseError,
  LogLevel,
} from '@notionhq/client';
import { getResponseHeader } from '@notionhq/client/build/src/errors';
import { NotionToMarkdown } from 'notion-to-md';
import { LoggerUtils } from '../../utils/logger.utils';
import {
  ADMIN_NOTICES_CACHE_TTL_MS,
  ADMIN_NOTICES_REFRESH_BUDGET_MS,
  NOTION_API_VERSION,
  NOTION_BODY_FETCH_MAX_NOTICES,
  NOTION_BODY_MAX_BLOCK_PAGES,
  NOTION_MIN_REQUEST_INTERVAL_MS,
  NOTION_PROPERTY,
  NOTION_QUERY_MAX_PAGES,
  NOTION_QUERY_PAGE_SIZE,
  NOTION_RATE_LIMIT_DEFAULT_COOLDOWN_MS,
  NOTION_RATE_LIMIT_MAX_COOLDOWN_MS,
} from './admin-notices.constants';
import {
  AdminNotice,
  NotionDatabaseQueryResponse,
  NotionPageObject,
  NotionRichTextItem,
} from './admin-notices.types';

const UNAVAILABLE_MESSAGE =
  '공지사항을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.';

/**
 * Read-only Notion client for the admin notice board. The Notion database is
 * the single source of truth (CRUD happens only in Notion); this service
 * queries published rows sorted by the `노출 순서` property and serves them
 * from a
 * short-lived in-memory cache with stale-while-revalidate refresh, so page
 * views neither hit the Notion API on every request nor wait for it.
 */
@Injectable()
export class AdminNoticesService {
  private readonly logger = LoggerUtils.getContextLogger(
    AdminNoticesService.name,
  );
  /** Official Notion SDK client shared by the query and the markdown reader. */
  private readonly notion: Client;
  /**
   * notion-to-md converter wired to the same official client instance, so
   * block-children requests reuse auth, timeout, pacing and the 429 handling
   * of the database query instead of bypassing them.
   */
  private readonly markdownConverter: NotionToMarkdown;
  private readonly databaseId: string;
  /** Enabled only when both NOTION_API_KEY and NOTION_DATABASE_ID are set. */
  private readonly enabled: boolean;
  /** In-memory cache TTL, overridable via NOTION_CACHE_TTL_MS (notion.cacheTtlMs). */
  private readonly cacheTtlMs: number;
  /**
   * Minimum gap between outgoing Notion requests (~3 req/s budget),
   * overridable via NOTION_MIN_REQUEST_INTERVAL_MS (notion.minRequestIntervalMs).
   */
  private readonly minRequestIntervalMs: number;
  /**
   * Wall-clock budget bounding how long one caller waits for a refresh
   * sequence, overridable via NOTION_REFRESH_BUDGET_MS
   * (notion.refreshBudgetMs). The per-request `NOTION_TIMEOUT` bounds each
   * Notion call, but the sequence is serial and unbounded in aggregate.
   */
  private readonly refreshBudgetMs: number;
  /** Earliest timestamp for the next outgoing Notion request (pacing). */
  private nextRequestAt = 0;
  /** While the clock is before this, a 429 pause is honored without re-querying. */
  private rateLimitedUntil = 0;
  /** Single-flight handle: concurrent cache misses share one Notion fetch. */
  private inFlight: Promise<AdminNotice[]> | null = null;
  /**
   * Single-flight handle for body-free (light) fetches: concurrent cold
   * `/top` reads share one query sequence. Never writes the cache, which
   * only ever holds full items (with bodies).
   */
  private lightFlight: Promise<AdminNotice[]> | null = null;
  private disabledLogged = false;
  private cache: { items: AdminNotice[]; fetchedAt: number } | null = null;

  constructor(configService: ConfigService) {
    const apiKey = configService.get<string>('notion.apiKey') ?? '';
    this.databaseId = configService.get<string>('notion.databaseId') ?? '';
    this.enabled = Boolean(apiKey && this.databaseId);
    this.cacheTtlMs =
      configService.get<number>('notion.cacheTtlMs') ??
      ADMIN_NOTICES_CACHE_TTL_MS;
    this.minRequestIntervalMs =
      configService.get<number>('notion.minRequestIntervalMs') ??
      NOTION_MIN_REQUEST_INTERVAL_MS;
    this.refreshBudgetMs =
      configService.get<number>('notion.refreshBudgetMs') ??
      ADMIN_NOTICES_REFRESH_BUDGET_MS;
    const baseUrl = (
      configService.get<string>('notion.apiUrl') ?? 'https://api.notion.com'
    ).replace(/\/+$/, '');
    // Create the Notion client instance.
    this.notion = new Client({
      auth: apiKey,
      baseUrl,
      notionVersion: NOTION_API_VERSION,
      timeoutMs: configService.get<number>('notion.timeout') ?? 5000,
      retry: false,
      logLevel: LogLevel.ERROR,
      fetch: async (url, init) => {
        await this.waitForRequestSlot();
        return globalThis.fetch(url, init);
      },
    });
    this.markdownConverter = new NotionToMarkdown({
      notionClient: this.notion,
      config: { parseChildPages: false, convertImagesToBase64: false },
    });
  }

  /**
   * Returns published rows sorted by display order (ascending), with the
   * unconfigured and transient-failure fallbacks:
   * - unconfigured: empty list (feature-off is a normal state)
   * - expired TTL: the stale snapshot is served immediately and the refresh
   *   runs in the background (stale-while-revalidate), so a slow Notion call
   *   never blocks a page view — the new data appears from the next request
   *   on. A cold cache (no snapshot yet) still has to wait for the first fetch.
   * - Notion error: the snapshot keeps being served, 503 only when none exists
   * Pass `{ includeBodies: false }` for callers that only need the ranked
   * list (the `/top` cap-1 endpoints): the cold path then skips the block
   * conversions entirely — the dominant cost — and never writes the cache
   * (which only ever holds full items), while a full refresh is kicked off
   * behind it so the first list/detail view is already warm.
   * Every cold wait is additionally bounded by the refresh budget: exceeding
   * it answers 503 fast while the fetch continues in the background and
   * still warms the cache on success, so one pathological board cannot hold
   * waiters for minutes.
   * Rate-limit defenses: single-flight (concurrent misses and background
   * refreshes share one fetch), request pacing (~3 req/s budget) and a 429
   * Retry-After pause.
   */
  async getPublishedNotices(
    options: { includeBodies?: boolean } = {},
  ): Promise<AdminNotice[]> {
    const includeBodies = options.includeBodies ?? true;
    if (!this.enabled) {
      if (!this.disabledLogged) {
        this.disabledLogged = true;
        this.logger.log(
          'admin notices disabled: NOTION_API_KEY / NOTION_DATABASE_ID is not set',
        );
      }
      return [];
    }

    const cached = this.cache;
    if (cached && Date.now() - cached.fetchedAt < this.cacheTtlMs) {
      return cached.items;
    }

    // Inside a 429 pause: do not touch Notion again — serve the snapshot
    // (stale is fine) or fail fast; hammering would extend the pause.
    if (Date.now() < this.rateLimitedUntil) {
      if (cached) {
        return cached.items;
      }
      throw new ServiceUnavailableException(UNAVAILABLE_MESSAGE);
    }

    if (cached) {
      // Stale-while-revalidate: answer from the snapshot now and refresh in
      // the background; failures are logged inside the flight and the stale
      // data keeps being served.
      this.refreshFull().catch(() => undefined);
      return cached.items;
    }

    // Cold cache: there is no snapshot to serve, so this request must wait
    // for the fetch — bounded by the refresh budget, never minutes.
    try {
      if (!includeBodies) {
        const light = await this.waitWithBudget(this.refreshLight());
        // Warm the cache behind the fast answer for list/detail callers;
        // its failure is logged inside the flight and swallowed here.
        this.refreshFull().catch(() => undefined);
        return light;
      }
      return await this.waitWithBudget(this.refreshFull());
    } catch {
      if (this.cache) {
        // A pinned board must not blink out on a transient Notion failure;
        // the stale snapshot is refreshed on the next successful fetch.
        // (Also covers a refresh that filled the cache while this waiter
        // gave up on the budget: serve the fresh data instead of a 503.)
        return this.cache.items;
      }
      throw new ServiceUnavailableException(UNAVAILABLE_MESSAGE);
    }
  }

  /**
   * Single-flight full Notion refresh shared by cold-start waiters and
   * background revalidations: a burst of concurrent triggers causes exactly
   * one query sequence, not one per visitor. The fetch always runs to
   * completion in the background (callers bound only their own wait with
   * the refresh budget), so a budget timeout still warms the cache for the
   * next request. The cache is updated on success; failures apply the 429
   * backoff and are logged once per flight, then rethrown for the caller
   * (background callers swallow it).
   */
  private refreshFull(): Promise<AdminNotice[]> {
    if (!this.inFlight) {
      this.inFlight = this.fetchPublishedNotices(true)
        .then((items) => {
          this.cache = { items, fetchedAt: Date.now() };
          return items;
        })
        .catch((error) => {
          this.applyRateLimitBackoff(error);
          this.logFetchFailure(error);
          throw error;
        })
        .finally(() => {
          this.inFlight = null;
        });
    }
    return this.inFlight;
  }

  /**
   * Single-flight body-free refresh for the `/top` cold path: concurrent
   * cold top reads share one query sequence with no block conversions.
   * Never writes the cache (see `getPublishedNotices`); failures apply the
   * 429 backoff and are logged once per flight, then rethrown.
   */
  private refreshLight(): Promise<AdminNotice[]> {
    if (!this.lightFlight) {
      this.lightFlight = this.fetchPublishedNotices(false)
        .catch((error) => {
          this.applyRateLimitBackoff(error);
          this.logFetchFailure(error);
          throw error;
        })
        .finally(() => {
          this.lightFlight = null;
        });
    }
    return this.lightFlight;
  }

  /**
   * Bounds how long one caller waits for a refresh sequence: the fetch
   * itself keeps running (single-flight is preserved, no duplicate
   * sequences), but this waiter answers 503 after the budget instead of
   * holding the response open for minutes.
   */
  private waitWithBudget(
    operation: Promise<AdminNotice[]>,
  ): Promise<AdminNotice[]> {
    if (this.refreshBudgetMs <= 0) {
      return operation;
    }
    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `notion refresh exceeded the ${this.refreshBudgetMs}ms budget; answering 503 while the fetch continues in the background`,
            ),
          ),
        this.refreshBudgetMs,
      );
    });
    return Promise.race([operation, budget]).finally(() => clearTimeout(timer));
  }

  /** Logged once per flight so a herd of waiters does not spam logs. */
  private logFetchFailure(error: unknown): void {
    this.logger.warn(
      this.cache
        ? `notion notice fetch failed; serving last good snapshot: ${this.describeError(error)}`
        : `notion notice fetch failed: ${this.describeError(error)}`,
    );
  }

  /**
   * Fetches the published rows with or without their block bodies. The
   * `/top` cold path passes `false`: ranking needs only the query rows.
   */
  private async fetchPublishedNotices(
    includeBodies: boolean,
  ): Promise<AdminNotice[]> {
    const notices = await this.queryPublishedRows();
    if (includeBodies) {
      await this.attachNoticeBodies(notices);
    }
    return this.sortByOrder(notices);
  }

  /** Paginates the Notion database query (bounded by NOTION_QUERY_MAX_PAGES). */
  private async queryPublishedRows(): Promise<AdminNotice[]> {
    const notices: AdminNotice[] = [];
    let startCursor: string | undefined = undefined;

    for (let page = 0; page < NOTION_QUERY_MAX_PAGES; page++) {
      // Request pacing happens inside the SDK's fetch hook (one shared
      // timeline for every Notion request), so no explicit wait is needed
      // here anymore.
      const response = await this.notion.request<NotionDatabaseQueryResponse>({
        // The SDK prefixes `${baseUrl}/v1/`, so the path carries no /v1.
        path: `databases/${this.databaseId}/query`,
        method: 'post',
        body: {
          filter: {
            property: NOTION_PROPERTY.PUBLISHED,
            checkbox: { equals: true },
          },
          sorts: [{ property: NOTION_PROPERTY.ORDER, direction: 'ascending' }],
          page_size: NOTION_QUERY_PAGE_SIZE,
          ...(startCursor ? { start_cursor: startCursor } : {}),
        },
      });

      for (const row of response.results ?? []) {
        const notice = this.mapPage(row);
        if (notice) {
          notices.push(notice);
        }
      }

      if (!response.has_more || !response.next_cursor) {
        break;
      }
      startCursor = response.next_cursor;
      if (page === NOTION_QUERY_MAX_PAGES - 1) {
        this.logger.warn(
          `notion notice query reached the ${NOTION_QUERY_MAX_PAGES}-page cap; remaining rows were skipped`,
        );
      }
    }

    return notices;
  }

  /**
   * Fills each notice with the Markdown conversion of its page block tree.
   * The property-based `content` keeps serving as the list preview and as
   * the body fallback when a page has no blocks or one conversion fails.
   * Sequential on purpose: the pacing timeline is global and serial anyway.
   */
  private async attachNoticeBodies(notices: AdminNotice[]): Promise<void> {
    for (let index = 0; index < notices.length; index++) {
      if (index >= NOTION_BODY_FETCH_MAX_NOTICES) {
        this.logger.warn(
          `notion notice body conversion capped at ${NOTION_BODY_FETCH_MAX_NOTICES} notices; remaining bodies were skipped`,
        );
        break;
      }
      notices[index].body = await this.fetchBodyMarkdown(notices[index].id);
    }
  }

  /**
   * Converts one page's block tree (the JSON block objects Notion stores as
   * the page body) to Markdown via notion-to-md. Failure degrades per notice:
   * a 429 is rethrown so the shared backoff pauses all Notion traffic, any
   * other error leaves `body` empty and the property content still renders.
   */
  private async fetchBodyMarkdown(pageId: string): Promise<string> {
    try {
      const mdBlocks = await this.markdownConverter.pageToMarkdown(
        pageId,
        NOTION_BODY_MAX_BLOCK_PAGES,
      );
      const markdown =
        this.markdownConverter.toMarkdownString(mdBlocks).parent ?? '';
      return markdown.trim();
    } catch (error) {
      if (isHTTPResponseError(error) && error.status === 429) {
        throw error;
      }
      this.logger.warn(
        `notion body conversion failed for page ${pageId}: ${this.describeError(error)}`,
      );
      return '';
    }
  }

  /**
   * Enforces Notion's ~3 req/s budget: sleeps until the minimum gap since the
   * previous outgoing request has passed. Slots are reserved in arrival order
   * so pagination bursts and refetches share one pacing timeline. Called from
   * the SDK fetch hook, so every Notion request — query or block children —
   * passes through here exactly once.
   */
  private async waitForRequestSlot(): Promise<void> {
    if (this.minRequestIntervalMs <= 0) {
      return;
    }
    const now = Date.now();
    const scheduledAt = Math.max(now, this.nextRequestAt);
    this.nextRequestAt = scheduledAt + this.minRequestIntervalMs;
    if (scheduledAt > now) {
      await new Promise((resolve) => setTimeout(resolve, scheduledAt - now));
    }
  }

  /**
   * Records a 429 pause (honoring Retry-After, capped) so later calls stop
   * querying Notion until the rate-limit window passes.
   */
  private applyRateLimitBackoff(error: unknown): void {
    if (!isHTTPResponseError(error) || error.status !== 429) {
      return;
    }
    const parsedSeconds = Number.parseInt(
      getResponseHeader(error.headers, 'retry-after') ?? '',
      10,
    );
    const cooldownMs = Number.isFinite(parsedSeconds)
      ? Math.min(
          Math.max(parsedSeconds, 0) * 1000,
          NOTION_RATE_LIMIT_MAX_COOLDOWN_MS,
        )
      : NOTION_RATE_LIMIT_DEFAULT_COOLDOWN_MS;
    this.rateLimitedUntil = Date.now() + cooldownMs;
    this.logger.warn(
      `notion rate limited (429); pausing Notion requests for ${cooldownMs}ms`,
    );
  }

  /** Maps one Notion page to the API shape; drops unpublished/empty-title rows. */
  private mapPage(page: NotionPageObject): AdminNotice | null {
    const properties = page.properties ?? {};
    const title = this.readPlainText(properties[NOTION_PROPERTY.TITLE]?.title);

    // Defense in depth: the query already filters on `공개 여부`.
    const published = properties[NOTION_PROPERTY.PUBLISHED]?.checkbox === true;
    if (!published || !title) {
      return null;
    }

    const statusProperty = properties[NOTION_PROPERTY.STATUS];
    const status =
      statusProperty?.status?.name ?? statusProperty?.select?.name ?? null;

    const rawOrder = properties[NOTION_PROPERTY.ORDER]?.number;
    const order =
      typeof rawOrder === 'number' && Number.isFinite(rawOrder)
        ? rawOrder
        : null;

    const content = this.readPlainText(
      properties[NOTION_PROPERTY.CONTENT]?.rich_text,
    );

    const urgent = properties[NOTION_PROPERTY.URGENT]?.checkbox === true;

    // created_time is a top-level page field, so no extra Notion call is
    // needed; it stays stable across edits (row creation, not publication).
    const createdAt =
      typeof page.created_time === 'string' && page.created_time
        ? page.created_time
        : null;

    return {
      id: page.id,
      title,
      published,
      status,
      order,
      urgent,
      content,
      // Filled by attachNoticeBodies from the page block tree.
      body: '',
      createdAt,
    };
  }

  /** Concatenates Notion rich text runs; preserves newlines in the body. */
  private readPlainText(items: NotionRichTextItem[] | undefined): string {
    return (items ?? []).map((item) => item.plain_text ?? '').join('');
  }

  /**
   * Re-applies `노출 순서` (display order) ascending in memory (nulls last).
   * Array.sort is
   * stable, so equal/missing orders keep the order Notion returned.
   */
  private sortByOrder(notices: AdminNotice[]): AdminNotice[] {
    return [...notices].sort((a, b) => {
      const aOrder = a.order ?? Number.POSITIVE_INFINITY;
      const bOrder = b.order ?? Number.POSITIVE_INFINITY;
      if (aOrder === bOrder) {
        return 0;
      }
      return aOrder < bOrder ? -1 : 1;
    });
  }

  /** Error description for logs only — never includes the API key. */
  private describeError(error: unknown): string {
    if (error instanceof APIResponseError) {
      return `${error.message} (status ${error.status})`;
    }
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}
