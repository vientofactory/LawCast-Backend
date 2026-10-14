import { APP_CONSTANTS } from '../config/app.config';
import {
  isChromiumFamily,
  pickBrowserFamily,
  pickBrowserIdentity,
  pickBrowserIdentityInFamily,
  type BrowserFamily,
  type BrowserIdentity,
  type RandomSource,
} from './browser-identities.util';

/**
 * Request headers for the crawler's plain-HTTP paths, built from a real browser
 * identity rather than a product token.
 *
 * A blocked User-Agent is only the first thing a portal (or the WAF in front of
 * it) can judge. The plain-HTTP requests this app makes used to carry a
 * User-Agent plus three generic headers, which is a shape no real navigation
 * ever has: browsers also send `Accept-Language` for the user's locale, User-Agent
 * client hints (`sec-ch-ua`, `sec-ch-ua-mobile`, `sec-ch-ua-platform`) on
 * Chromium, `Upgrade-Insecure-Requests`, and the `Sec-Fetch-*` request metadata
 * that lets a server distinguish a top-level navigation from an in-page call.
 * Missing them is itself the tell, so they are built here from the selected
 * identity — not from a fixed template — so a request never advertises one
 * browser in its User-Agent and another in its hints.
 *
 * The same helpers honor `CRAWLING_USER_AGENT`: when an operator pins a value,
 * every request sends exactly that User-Agent with the pre-existing generic
 * header set and no browser client hints. Pinning is an escape hatch for a
 * portal that refuses the rotation; rotating identities is the default.
 */

/** `Accept` a browser sends for a top-level navigation. */
const NAVIGATION_ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';

/** `Accept-Language` sent by a Korean-locale browser. */
const ACCEPT_LANGUAGE = 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7';

/**
 * Grease brand Chromium browsers list in `sec-ch-ua` to discourage brand
 * sniffing. The token is meaningless by design and its exact spelling changes
 * between builds; this is one of the forms Chrome ships.
 */
const GREASED_BRAND = '"Not A;Brand";v="99"';

const CHROMIUM_BRAND_LABEL: Record<'chrome' | 'edge', string> = {
  chrome: '"Google Chrome"',
  edge: '"Microsoft Edge"',
};

/**
 * Headers a client needs for pal-crawl's config shape: the User-Agent plus the
 * `customHeaders` object the client merges into every request.
 */
export interface CrawlerRequestHeaders {
  /** User-Agent passed to the client's own config field. */
  userAgent: string;
  /** Header object handed to the client (`customHeaders`). */
  customHeaders: Record<string, string>;
}

export interface CrawlerIdentityOptions {
  /** Overrides `CRAWLING_USER_AGENT` (used by tests and explicit callers). */
  pinnedUserAgent?: string | null;
  /** Randomness source, injectable so tests can be deterministic. */
  random?: RandomSource;
  /** Restricts the rotation to one family (see `createCrawlerClientHeaders`). */
  family?: BrowserFamily;
}

/**
 * Builds the header set a browser with this identity sends for a top-level
 * navigation.
 *
 * `Cache-Control: no-cache` is the one deliberate deviation from what a browser
 * sends on a normal navigation: the listing must not come from an intermediary
 * cache, and the crawler sends no conditional headers, so it is a request
 * directive rather than a claim about the client that would contradict the
 * identity above it.
 */
export function buildBrowserRequestHeaders(
  identity: BrowserIdentity,
): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': identity.userAgent,
    Accept: NAVIGATION_ACCEPT,
    'Accept-Language': ACCEPT_LANGUAGE,
    'Cache-Control': 'no-cache',
  };

  if (isChromiumFamily(identity.family)) {
    headers['sec-ch-ua'] =
      `${GREASED_BRAND}, "Chromium";v="${identity.significantVersion}", ` +
      `${CHROMIUM_BRAND_LABEL[identity.family]};v="${identity.significantVersion}"`;
    headers['sec-ch-ua-mobile'] = identity.mobile ? '?1' : '?0';
    headers['sec-ch-ua-platform'] = `"${identity.platform}"`;
  }

  if (identity.family !== 'safari') {
    // Safari sends neither client hints nor `Sec-Fetch-*`, so a Safari identity
    // that advertised them would be a mismatch rather than camouflage. The site
    // is reached by direct navigation (no Referer is available from the client),
    // which is what `Sec-Fetch-Site: none` describes.
    headers['Upgrade-Insecure-Requests'] = '1';
    headers['Sec-Fetch-Dest'] = 'document';
    headers['Sec-Fetch-Mode'] = 'navigate';
    headers['Sec-Fetch-Site'] = 'none';
    headers['Sec-Fetch-User'] = '?1';
  }

  return headers;
}

/** The `CRAWLING_USER_AGENT` value, or `null` when the crawler rotates. */
export function getPinnedUserAgent(): string | null {
  const pinned = APP_CONSTANTS.CRAWLING.USER_AGENT?.trim();
  return pinned ? pinned : null;
}

function resolvePinnedUserAgent(
  options: CrawlerIdentityOptions = {},
): string | null {
  return options.pinnedUserAgent !== undefined
    ? options.pinnedUserAgent?.trim() || null
    : getPinnedUserAgent();
}

/**
 * The User-Agent a single request should carry: the pinned one when an operator
 * set `CRAWLING_USER_AGENT`, otherwise a random identity from the pool.
 */
export function resolveCrawlerUserAgent(
  options: CrawlerIdentityOptions = {},
): string {
  const pinned = resolvePinnedUserAgent(options);
  if (pinned) {
    return pinned;
  }

  return pickBrowserIdentity(options.random).userAgent;
}

/**
 * Header set for one of our own (axios) fetches.
 *
 * A fresh identity is drawn per call because each call builds its own header
 * object, so unlike the pal-crawl path this one can rotate whole identities —
 * family included — request by request.
 */
export function createCrawlerFetchHeaders(
  options: CrawlerIdentityOptions = {},
): CrawlerRequestHeaders {
  const pinned = resolvePinnedUserAgent(options);
  if (pinned) {
    return {
      userAgent: pinned,
      customHeaders: { ...APP_CONSTANTS.CRAWLING.HEADERS },
    };
  }

  const identity = pickBrowserIdentity(options.random);

  return {
    userAgent: identity.userAgent,
    customHeaders: buildBrowserRequestHeaders(identity),
  };
}

/**
 * Header set for a long-lived pal-crawl client (`PalCrawl`, `NsmLmSts`,
 * `LikmsNsmAdapter`, `LikmsCrawler`).
 *
 * pal-crawl reads its per-request headers as
 * `{ 'User-Agent': config.userAgent, ...config.customHeaders, ...extraHeaders }`
 * (`dist/http-client.js` `makeRequest`), so an own *accessor* property on
 * `customHeaders` is evaluated once per request. That is what lets one client —
 * created per crawl operation, and a full sync walks hundreds of pages — send a
 * different real browser identity on every request instead of pinning one for
 * its whole lifetime.
 *
 * `'User-Agent'` is defined first on purpose: an object spread copies own keys
 * in insertion order, so it runs before the identity-dependent headers and can
 * pin the identity they describe. Without that ordering one request could
 * advertise Chrome in the User-Agent and Edge in `sec-ch-ua`.
 *
 * The family, by contrast, is chosen once per client: it decides *which* headers
 * exist (client hints and `Sec-Fetch-*` on Chromium, neither on Safari), and
 * pal-crawl merges a fixed set of names, so a family cannot change per request.
 * Different operations draw different families, so the fleet still looks mixed.
 */
export function createCrawlerClientHeaders(
  options: CrawlerIdentityOptions = {},
): CrawlerRequestHeaders {
  const pinned = resolvePinnedUserAgent(options);
  if (pinned) {
    return {
      userAgent: pinned,
      customHeaders: { ...APP_CONSTANTS.CRAWLING.HEADERS },
    };
  }

  const random = options.random ?? Math.random;
  const family = options.family ?? pickBrowserFamily(random);
  const headerNames = browserHeaderNamesForFamily(family);
  const customHeaders: Record<string, string> = {};

  let identity = pickBrowserIdentityInFamily(family, random);

  defineRotatingHeader(customHeaders, 'User-Agent', () => {
    identity = pickBrowserIdentityInFamily(family, random);
    return identity.userAgent;
  });

  for (const name of headerNames) {
    defineRotatingHeader(
      customHeaders,
      name,
      () => buildBrowserRequestHeaders(identity)[name],
    );
  }

  return { userAgent: identity.userAgent, customHeaders };
}

/** Header names (minus `User-Agent`) that the family's identities send. */
function browserHeaderNamesForFamily(family: BrowserFamily): string[] {
  const sample = buildBrowserRequestHeaders(
    pickBrowserIdentityInFamily(family, () => 0),
  );

  return Object.keys(sample).filter((name) => name !== 'User-Agent');
}

function defineRotatingHeader(
  target: Record<string, string>,
  name: string,
  read: () => string,
): void {
  Object.defineProperty(target, name, {
    enumerable: true,
    configurable: true,
    get: read,
  });
}
