/**
 * Browser identities for the crawler's plain-HTTP request paths.
 *
 * The pipeline sends two very different kinds of request: real browser
 * navigations (Puppeteer) and plain HTTP requests (pal-crawl's `https`-based
 * client and our own axios fetches for detail-page probes). The plain ones used
 * to carry a single product-token User-Agent (`LawCast/1.0 (Legislative Notice
 * Crawler)`), which one portal answered with a 200 "site error page" instead of
 * its listing — a block that stayed invisible for five weeks
 * (`agent_memories/32-nsm-ua-block-and-probe-storm/`).
 *
 * The identities below are real, shipped User-Agent strings (captured
 * 2026-10-14), not synthesized ones. That matters because bot filters rarely
 * match a single token: they look for *internal inconsistency* — a Chrome token
 * paired with another browser's client hints, a platform claim that contradicts
 * the header set. Each entry therefore carries the family/platform/version that
 * `browser-request-headers.util.ts` needs to emit the matching headers, and the
 * pool is only useful together with those headers.
 *
 * Refresh the versions when the majors advance; the UA format is stable, only
 * the numbers move (Chrome reports `MAJOR.0.0.0`, Firefox and Safari report
 * their full version).
 */

export type BrowserFamily = 'chrome' | 'edge' | 'firefox' | 'safari';

export type BrowserPlatform = 'Windows' | 'macOS' | 'Linux' | 'Android' | 'iOS';

export interface BrowserIdentity {
  /** Engine family; decides which client hints the identity sends. */
  family: BrowserFamily;
  /** `sec-ch-ua-platform` value and the platform named inside `userAgent`. */
  platform: BrowserPlatform;
  /** Mobile identity (`sec-ch-ua-mobile: ?1`, `Mobile` token in the UA). */
  mobile: boolean;
  /** Version reported in `sec-ch-ua` (Chrome/Edge major, Firefox/Safari full). */
  significantVersion: string;
  /** Full `User-Agent` header value. */
  userAgent: string;
}

export type RandomSource = () => number;

/**
 * Real browser identities, weighted towards what a Korean desktop fleet looks
 * like (Chrome and Edge on Windows first) because that is the traffic the
 * notice portals normally serve.
 */
export const BROWSER_IDENTITIES: readonly BrowserIdentity[] = [
  {
    family: 'chrome',
    platform: 'Windows',
    mobile: false,
    significantVersion: '155',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  },
  {
    family: 'chrome',
    platform: 'Windows',
    mobile: false,
    significantVersion: '154',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
  },
  {
    family: 'chrome',
    platform: 'macOS',
    mobile: false,
    significantVersion: '155',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  },
  {
    family: 'chrome',
    platform: 'Linux',
    mobile: false,
    significantVersion: '154',
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
  },
  {
    family: 'chrome',
    platform: 'Android',
    mobile: true,
    significantVersion: '155',
    userAgent:
      'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36',
  },
  {
    family: 'edge',
    platform: 'Windows',
    mobile: false,
    significantVersion: '155',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0',
  },
  {
    family: 'edge',
    platform: 'macOS',
    mobile: false,
    significantVersion: '155',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0',
  },
  {
    family: 'firefox',
    platform: 'Windows',
    mobile: false,
    significantVersion: '157.0',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:157.0) Gecko/20100101 Firefox/157.0',
  },
  {
    family: 'firefox',
    platform: 'macOS',
    mobile: false,
    significantVersion: '156.0',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:156.0) Gecko/20100101 Firefox/156.0',
  },
  {
    family: 'firefox',
    platform: 'Linux',
    mobile: false,
    significantVersion: '157.0',
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64; rv:157.0) Gecko/20100101 Firefox/157.0',
  },
  {
    family: 'safari',
    platform: 'macOS',
    mobile: false,
    significantVersion: '27.0',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15',
  },
  {
    family: 'safari',
    platform: 'iOS',
    mobile: true,
    significantVersion: '27.0',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1',
  },
];

/** Every family represented in `BROWSER_IDENTITIES`. */
export const BROWSER_FAMILIES: readonly BrowserFamily[] = [
  'chrome',
  'edge',
  'firefox',
  'safari',
];

/**
 * Whether the family is Chromium-based. Chromium and Firefox both send
 * `Sec-Fetch-*`; only Chromium sends User-Agent client hints, and Safari sends
 * neither (see `browser-request-headers.util.ts`).
 */
export function isChromiumFamily(
  family: BrowserFamily,
): family is 'chrome' | 'edge' {
  return family === 'chrome' || family === 'edge';
}

function randomIndex(length: number, random: RandomSource): number {
  if (length <= 1) {
    return 0;
  }

  // Clamp instead of trusting `random()` to stay inside [0, 1): an injected
  // source (tests, future callers) may return 1 exactly.
  return Math.min(length - 1, Math.max(0, Math.floor(random() * length)));
}

/** Picks an identity from the whole pool. */
export function pickBrowserIdentity(
  random: RandomSource = Math.random,
): BrowserIdentity {
  return BROWSER_IDENTITIES[randomIndex(BROWSER_IDENTITIES.length, random)];
}

/**
 * Picks an identity from one family.
 *
 * The *set* of headers a browser sends is decided by its family (client hints
 * and `Sec-Fetch-*` exist on Chromium, not on Safari), and a caller that merges
 * one fixed set of header names per request — pal-crawl does — cannot switch
 * families mid-client. It can still rotate the identity that fills those names,
 * which is what this is for.
 */
export function pickBrowserIdentityInFamily(
  family: BrowserFamily,
  random: RandomSource = Math.random,
): BrowserIdentity {
  const candidates = BROWSER_IDENTITIES.filter(
    (identity) => identity.family === family,
  );
  const pool = candidates.length > 0 ? candidates : BROWSER_IDENTITIES;

  return pool[randomIndex(pool.length, random)];
}

/** Picks the family a request will present itself as. */
export function pickBrowserFamily(
  random: RandomSource = Math.random,
): BrowserFamily {
  return BROWSER_FAMILIES[randomIndex(BROWSER_FAMILIES.length, random)];
}
