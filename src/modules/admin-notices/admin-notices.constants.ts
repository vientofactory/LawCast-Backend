/**
 * Notion database contract for the admin notice board.
 * Property names must match the properties of the configured Notion
 * database exactly (CRUD is done in Notion only; this side is read-only).
 */
export const NOTION_PROPERTY = {
  /** Notion `제목` (title) property name. */
  TITLE: '제목',
  /** Notion `공개 여부` (checkbox): the publication gate, only checked rows are exposed. */
  PUBLISHED: '공개 여부',
  /** Notion `상태` (status | select): surfaced as metadata, never used as a gate. */
  STATUS: '상태',
  /** Notion `노출 순서` (number): ascending display order. */
  ORDER: '노출 순서',
  /** Notion `긴급` (checkbox): the top urgent notice renders a site-wide banner. */
  URGENT: '긴급',
  /** Notion `내용` (rich text): notice body shown on the main page. */
  CONTENT: '내용',
} as const;

export const NOTION_API_VERSION = '2022-06-28';

/** Notion allows at most 100 rows per database query request. */
export const NOTION_QUERY_PAGE_SIZE = 100;

/**
 * Minimum gap between outgoing Notion requests. Notion rate-limits
 * integrations to ~3 requests/second on average; 340ms sustains ~2.9 req/s
 * so pagination bursts stay inside the budget. Overridable via
 * NOTION_MIN_REQUEST_INTERVAL_MS (values <= 0 disable pacing).
 */
export const NOTION_MIN_REQUEST_INTERVAL_MS = 340;

/** Cooldown applied when a 429 arrives without a Retry-After header. */
export const NOTION_RATE_LIMIT_DEFAULT_COOLDOWN_MS = 1000;

/** Upper bound for honoring Retry-After so one bad header cannot stall the board. */
export const NOTION_RATE_LIMIT_MAX_COOLDOWN_MS = 60 * 1000;

/** Upper bound on pagination loops — a notice board never needs more. */
export const NOTION_QUERY_MAX_PAGES = 10;

/**
 * Default in-memory TTL for fetched notices so each main-page view does not
 * hit the Notion API (Notion rate-limits aggressively; one shared backend
 * instance serves all visitors). Operators override it per environment via
 * the NOTION_CACHE_TTL_MS env var (see app.config.ts `notion.cacheTtlMs`).
 */
export const ADMIN_NOTICES_CACHE_TTL_MS = 60 * 1000;

/**
 * Upper bound on block pages (100 blocks each) converted per notice body so
 * one pathological page cannot stall a refresh loop.
 */
export const NOTION_BODY_MAX_BLOCK_PAGES = 2;

/**
 * Upper bound on notice bodies converted per refresh. Every body costs at
 * least one paced Notion request, so the cap keeps one oversized database
 * from stretching a refresh into minutes; rows beyond the cap keep the
 * property-based content as their body fallback.
 */
export const NOTION_BODY_FETCH_MAX_NOTICES = 50;

/**
 * Wall-clock budget for one refresh sequence (query pages plus body
 * conversions). The per-request `NOTION_TIMEOUT` bounds each Notion call,
 * but the sequence runs serially (shared pacing) and is unbounded in
 * aggregate — up to 10 query pages plus 50 body conversions — so without
 * this a pathological board holds every cold waiter for minutes. Exceeding
 * the budget answers 503 fast while the fetch continues in the background
 * and still warms the cache on success. Overridable via
 * NOTION_REFRESH_BUDGET_MS (values <= 0 disable the budget).
 */
export const ADMIN_NOTICES_REFRESH_BUDGET_MS = 15 * 1000;
