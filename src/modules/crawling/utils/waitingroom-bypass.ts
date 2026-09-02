import type { Page, HTTPResponse } from 'puppeteer';
import { APP_CONSTANTS } from '../../../config/app.config';
import { LoggerUtils } from '../../../utils/logger.utils';

const LOGGER_CTX = 'WaitingroomBypass';

/**
 * Pattern used to detect the Waitingroom page served by opinion.lawmaking.go.kr.
 * The page title includes "Waitingroom" when the user is queued.
 */
const WAITINGROOM_TITLE_PATTERN = /waitingroom/i;

export interface WaitingroomNavigateResult {
  /** Final HTTP response after bypass (may differ from initial goto). */
  response: HTTPResponse | null;
  /** Number of times the Waitingroom was encountered. */
  waitingroomHits: number;
  /** Total time spent waiting for Waitingroom redirects (ms). */
  waitingroomTotalWaitMs: number;
}

export interface WaitingroomNavigateOptions {
  /** Maximum retry attempts when Waitingroom redirect times out. */
  maxRetries?: number;
  /** Base delay (ms) between retries; multiplied by (attempt+1) for linear backoff. */
  retryDelayMs?: number;
  /** Timeout (ms) for the initial page.goto(). */
  gotoTimeoutMs?: number;
  /** Timeout (ms) for waitForNavigation() inside the Waitingroom loop. */
  navTimeoutMs?: number;
  /** Tag string for debug logging (e.g. bill number). */
  tag?: string;
}

const defaults = () => ({
  maxRetries: APP_CONSTANTS.CRAWLING.MAX_WAITINGROOM_RETRIES,
  retryDelayMs: APP_CONSTANTS.CRAWLING.WAITINGROOM_RETRY_DELAY_MS,
  gotoTimeoutMs: APP_CONSTANTS.CRAWLING.WAITINGROOM_GOTO_TIMEOUT_MS,
  navTimeoutMs: APP_CONSTANTS.CRAWLING.WAITINGROOM_NAV_TIMEOUT_MS,
});

/**
 * Checks whether the current page is a Waitingroom page by inspecting the title.
 */
export async function isWaitingroomPage(page: Page): Promise<boolean> {
  const title = await page.title();
  return WAITINGROOM_TITLE_PATTERN.test(title);
}

/**
 * String-based equivalent of `isWaitingroomPage`, for callers that only have
 * raw HTML (e.g. an HTTP-fetched response) rather than a live `Page`.
 */
export function isWaitingroomHtml(html: string): boolean {
  if (!html) return false;
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return titleMatch ? WAITINGROOM_TITLE_PATTERN.test(titleMatch[1]) : false;
}

/**
 * Navigates a Puppeteer page to `url` with Waitingroom bypass.
 *
 * The Waitingroom on opinion.lawmaking.go.kr uses a JavaScript polling timer
 * before redirecting to the real detail page. Using `networkidle0` on the
 * initial goto() resolves as soon as the Waitingroom itself becomes idle
 * (before the JS redirect), so we end up capturing the wrong HTML.
 *
 * Strategy:
 *   1. Use `domcontentloaded` — resolves immediately on either the real page
 *      or the Waitingroom without waiting for networkidle.
 *   2. Inspect the page title. If it's Waitingroom, call
 *      `waitForNavigation(networkidle0)` to wait for the JS redirect.
 *   3. Up to `maxRetries`: if waitForNavigation times out, reload the URL
 *      with a back-off delay and try again.
 *
 * @returns WaitingroomNavigateResult with the final response and telemetry.
 */
export async function navigateWithWaitingroomBypass(
  page: Page,
  url: string,
  opts: WaitingroomNavigateOptions = {},
): Promise<WaitingroomNavigateResult> {
  const cfg = { ...defaults(), ...opts };
  let waitingroomHits = 0;
  let waitingroomTotalWaitMs = 0;

  const t0 = Date.now();

  // ── Step 1: initial goto with domcontentloaded ──────────────────────
  let response: HTTPResponse | null = await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: cfg.gotoTimeoutMs,
  });

  // ── Step 2: Waitingroom loop ───────────────────────────────────────
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    if (!(await isWaitingroomPage(page))) break;

    waitingroomHits++;
    const tag = opts.tag ? ` [${opts.tag}]` : '';
    LoggerUtils.debugDev(
      LOGGER_CTX,
      `Waitingroom hit${tag} (attempt ${attempt + 1}/${cfg.maxRetries + 1}), waiting for redirect...`,
    );

    if (attempt < cfg.maxRetries) {
      const tNav0 = Date.now();
      try {
        const nav = await page.waitForNavigation({
          waitUntil: 'networkidle0',
          timeout: cfg.navTimeoutMs,
        });
        waitingroomTotalWaitMs += Date.now() - tNav0;
        if (nav) response = nav;
      } catch {
        waitingroomTotalWaitMs += Date.now() - tNav0;
        // waitForNavigation timed out — back-off then reload.
        const backoffMs = cfg.retryDelayMs * (attempt + 1);
        await delayMs(backoffMs);
        response = await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: cfg.gotoTimeoutMs,
        });
      }
    }
  }

  // ── Step 3: log if unresolved ──────────────────────────────────────
  if (waitingroomHits > cfg.maxRetries) {
    LoggerUtils.warn(
      LOGGER_CTX,
      `Waitingroom not resolved after ${cfg.maxRetries + 1} attempts${opts.tag ? ` for ${opts.tag}` : ''} — page content may still be a Waitingroom`,
    );
  }

  if (waitingroomHits > 0) {
    const totalMs = Date.now() - t0;
    LoggerUtils.debugDev(
      LOGGER_CTX,
      `Waitingroom bypass${opts.tag ? ` [${opts.tag}]` : ''} complete: ${waitingroomHits} hit(s), total wait ${waitingroomTotalWaitMs}ms, elapsed ${totalMs}ms`,
    );
  }

  return { response, waitingroomHits, waitingroomTotalWaitMs };
}

/**
 * Navigates a Puppeteer page to `url` with Waitingroom bypass and returns
 * the final HTML content.
 *
 * This is the primary escape hatch for HTTP-level (pal-crawl) requests that
 * hit a Waitingroom 307 redirect. The HTTP client cannot execute JavaScript,
 * so it can never follow the Waitingroom's client-side redirect. Puppeteer
 * can.
 */
export async function fetchPageHtmlViaBrowser(
  page: Page,
  url: string,
  opts: WaitingroomNavigateOptions = {},
): Promise<{ html: string; response: HTTPResponse | null }> {
  const { response } = await navigateWithWaitingroomBypass(page, url, opts);
  const html = await page.content();
  return { html, response };
}

/**
 * Returns true when an error message indicates the NSM site served a
 * Waitingroom redirect (HTTP 307) that the pal-crawl HTTP client could not
 * handle.
 */
export function isWaitingroomRedirectError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  // Match the pal-crawl HTTP client format: "Invalid response: 307 Temporary Redirect"
  // Also handle any wrapped errors (e.g. NsmCrawlContextError) by checking the cause.
  if (/307|temporary.?redirect/i.test(msg)) return true;
  // NsmCrawlContextError wraps the original error; check cause chain.
  if (error instanceof Error && 'cause' in error && error.cause) {
    return isWaitingroomRedirectError(error.cause);
  }
  return false;
}

/** Simple delay helper (same as delayMs in async-delay.utils but local). */
function delayMs(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
