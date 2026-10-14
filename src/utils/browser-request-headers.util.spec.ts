import { EventEmitter } from 'node:events';
import https from 'node:https';

import { NsmLmSts } from 'pal-crawl';

import { APP_CONSTANTS } from '../config/app.config';
import {
  BROWSER_IDENTITIES,
  pickBrowserIdentityInFamily,
  type BrowserFamily,
  type BrowserIdentity,
  type RandomSource,
} from './browser-identities.util';
import {
  buildBrowserRequestHeaders,
  createCrawlerClientHeaders,
  createCrawlerFetchHeaders,
  getPinnedUserAgent,
  resolveCrawlerUserAgent,
} from './browser-request-headers.util';

/** The `User-Agent` a real browser sends. */
const BROWSER_UA_PATTERN = /^Mozilla\/5\.0 \(/;

/** Deterministic randomness so rotation assertions cannot flake. */
function seededRandom(seed: number): RandomSource {
  let state = seed >>> 0;

  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function identityOf(userAgent: string): BrowserIdentity {
  const identity = BROWSER_IDENTITIES.find(
    (entry) => entry.userAgent === userAgent,
  );

  if (!identity) {
    throw new Error(`User-Agent is not in the pool: ${userAgent}`);
  }

  return identity;
}

const HTML_WITHOUT_LIST_ROWS =
  '<html><body><div id="containerWrap"><table class="gridCnt_table">' +
  '<tbody></tbody></table></div></body></html>';

/**
 * Captures the headers pal-crawl's `HttpClient` actually sends.
 *
 * pal-crawl builds a request's headers as
 * `{ 'User-Agent': config.userAgent, ...config.customHeaders, ...extraHeaders }`
 * inside `makeRequest`, and this app relies on that merge: it is what lets one
 * client rotate its identity per request through an accessor property. The stub
 * therefore inspects the real merge (through `NsmLmSts.search`) instead of
 * re-implementing it, so a future pal-crawl release that reorders the spread
 * fails here rather than shipping a silently pinned User-Agent.
 */
function capturePalCrawlRequestHeaders(): {
  headers: Array<Record<string, string>>;
  restore: () => void;
} {
  const headers: Array<Record<string, string>> = [];

  const spy = jest.spyOn(https, 'request').mockImplementation(((
    ...args: unknown[]
  ) => {
    const options = args[1] as { headers: Record<string, string> };
    headers.push({ ...options.headers });

    const request = new EventEmitter() as EventEmitter & {
      write: () => void;
      end: () => void;
      setTimeout: () => void;
      destroy: () => void;
    };
    request.write = () => undefined;
    request.end = () => undefined;
    request.setTimeout = () => undefined;
    request.destroy = () => undefined;

    setImmediate(() => {
      const callback = args[2] as (response: EventEmitter) => void;
      const response = new EventEmitter() as EventEmitter & {
        statusCode: number;
        statusMessage: string;
        headers: Record<string, string>;
      };
      response.statusCode = 200;
      response.statusMessage = 'OK';
      response.headers = { 'content-type': 'text/html; charset=utf-8' };

      callback(response);
      response.emit('data', Buffer.from(HTML_WITHOUT_LIST_ROWS));
      response.emit('end');
    });

    return request;
  }) as unknown as typeof https.request);

  return { headers, restore: () => spy.mockRestore() };
}

describe('buildBrowserRequestHeaders', () => {
  function identityOfFamily(family: BrowserFamily): BrowserIdentity {
    return pickBrowserIdentityInFamily(family, () => 0);
  }

  it('sends the locale, navigation Accept and freshness headers a browser sends', () => {
    const headers = buildBrowserRequestHeaders(identityOfFamily('chrome'));

    expect(headers['User-Agent']).toMatch(BROWSER_UA_PATTERN);
    expect(headers.Accept).toContain('text/html,application/xhtml+xml');
    expect(headers['Accept-Language']).toBe(
      'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    );
    expect(headers['Cache-Control']).toBe('no-cache');
  });

  it('sends Chromium client hints that describe the same identity', () => {
    for (const family of ['chrome', 'edge'] as const) {
      const identity = identityOfFamily(family);
      const headers = buildBrowserRequestHeaders(identity);

      expect(headers['sec-ch-ua']).toContain(
        `v="${identity.significantVersion}"`,
      );
      expect(headers['sec-ch-ua']).toContain('"Chromium"');
      expect(headers['sec-ch-ua']).toContain(
        family === 'edge' ? '"Microsoft Edge"' : '"Google Chrome"',
      );
      expect(headers['sec-ch-ua-mobile']).toBe(identity.mobile ? '?1' : '?0');
      expect(headers['sec-ch-ua-platform']).toBe(`"${identity.platform}"`);
    }
  });

  it('sends Sec-Fetch metadata for a top-level navigation', () => {
    const headers = buildBrowserRequestHeaders(identityOfFamily('chrome'));

    expect(headers['Upgrade-Insecure-Requests']).toBe('1');
    expect(headers['Sec-Fetch-Dest']).toBe('document');
    expect(headers['Sec-Fetch-Mode']).toBe('navigate');
    expect(headers['Sec-Fetch-Site']).toBe('none');
    expect(headers['Sec-Fetch-User']).toBe('?1');
  });

  it('keeps Firefox free of client hints but keeps Sec-Fetch', () => {
    const headers = buildBrowserRequestHeaders(identityOfFamily('firefox'));

    expect(headers).not.toHaveProperty('sec-ch-ua');
    expect(headers).not.toHaveProperty('sec-ch-ua-platform');
    expect(headers['Sec-Fetch-Site']).toBe('none');
  });

  it('sends neither client hints nor Sec-Fetch for Safari', () => {
    const headers = buildBrowserRequestHeaders(identityOfFamily('safari'));

    expect(headers).not.toHaveProperty('sec-ch-ua');
    expect(headers).not.toHaveProperty('Sec-Fetch-Site');
    expect(headers).not.toHaveProperty('Upgrade-Insecure-Requests');
    expect(headers['User-Agent']).toMatch(BROWSER_UA_PATTERN);
  });
});

describe('resolveCrawlerUserAgent', () => {
  it('reports the pinned User-Agent from configuration', () => {
    const configured = process.env.CRAWLING_USER_AGENT?.trim();

    expect(getPinnedUserAgent()).toBe(configured ? configured : null);
  });

  it('returns a browser identity when nothing is pinned', () => {
    expect(
      resolveCrawlerUserAgent({ pinnedUserAgent: null, random: () => 0 }),
    ).toBe(BROWSER_IDENTITIES[0].userAgent);
    expect(resolveCrawlerUserAgent({ pinnedUserAgent: '   ' })).toMatch(
      BROWSER_UA_PATTERN,
    );
  });

  it('returns the pinned value verbatim when one is set', () => {
    expect(resolveCrawlerUserAgent({ pinnedUserAgent: ' LawCast/2.0 ' })).toBe(
      'LawCast/2.0',
    );
  });
});

describe('createCrawlerFetchHeaders', () => {
  it('prepares a per-request browser identity for our own fetches', () => {
    const { userAgent, customHeaders } = createCrawlerFetchHeaders({
      pinnedUserAgent: null,
      random: () => 0,
    });

    expect(userAgent).toBe(BROWSER_IDENTITIES[0].userAgent);
    expect(customHeaders['User-Agent']).toBe(userAgent);
    expect(customHeaders['sec-ch-ua']).toContain('"Google Chrome"');
  });

  it('rotates whole identities between calls', () => {
    const random = seededRandom(7);
    const seen = new Set<string>();

    for (let call = 0; call < 8; call++) {
      seen.add(
        createCrawlerFetchHeaders({ pinnedUserAgent: null, random }).userAgent,
      );
    }

    expect(seen.size).toBeGreaterThan(1);
  });

  it('falls back to the generic header set when the User-Agent is pinned', () => {
    const { userAgent, customHeaders } = createCrawlerFetchHeaders({
      pinnedUserAgent: 'LawCast/1.0 (Legislative Notice Crawler)',
    });

    expect(userAgent).toBe('LawCast/1.0 (Legislative Notice Crawler)');
    expect(customHeaders).toEqual({ ...APP_CONSTANTS.CRAWLING.HEADERS });
    expect(customHeaders).not.toHaveProperty('sec-ch-ua');
  });
});

describe('createCrawlerClientHeaders', () => {
  it('rotates the identity on every pal-crawl request', async () => {
    const { userAgent, customHeaders } = createCrawlerClientHeaders({
      pinnedUserAgent: null,
      family: 'chrome',
      random: seededRandom(11),
    });

    const { headers, restore } = capturePalCrawlRequestHeaders();

    try {
      const client = new NsmLmSts({
        userAgent,
        timeout: 1000,
        retryCount: 1,
        customHeaders,
      });

      for (let request = 0; request < 6; request++) {
        await client.search({ pageIndex: 1, pageSize: 1 });
      }
    } finally {
      restore();
    }

    expect(headers).toHaveLength(6);

    for (const sent of headers) {
      const identity = identityOf(sent['User-Agent']);
      expect(identity.family).toBe('chrome');
      // The exact header set of the chosen identity: the User-Agent and every
      // client hint on the wire describe one browser, not a mixture.
      expect(sent).toEqual(buildBrowserRequestHeaders(identity));
    }

    expect(
      new Set(headers.map((sent) => sent['User-Agent'])).size,
    ).toBeGreaterThan(1);
  });

  it('describes a Safari identity without Chromium-only headers', async () => {
    const { userAgent, customHeaders } = createCrawlerClientHeaders({
      pinnedUserAgent: null,
      family: 'safari',
      random: seededRandom(3),
    });

    const { headers, restore } = capturePalCrawlRequestHeaders();

    try {
      const client = new NsmLmSts({
        userAgent,
        timeout: 1000,
        retryCount: 1,
        customHeaders,
      });

      await client.search({ pageIndex: 1, pageSize: 1 });
    } finally {
      restore();
    }

    expect(headers).toHaveLength(1);
    expect(headers[0]['User-Agent']).toMatch(BROWSER_UA_PATTERN);
    expect(headers[0]).not.toHaveProperty('sec-ch-ua');
    expect(headers[0]).not.toHaveProperty('Sec-Fetch-Site');
    expect(headers[0]).toEqual(
      buildBrowserRequestHeaders(identityOf(headers[0]['User-Agent'])),
    );
  });

  it('locks one family per client so the header names stay coherent', () => {
    for (const family of ['chrome', 'firefox', 'safari'] as const) {
      const { customHeaders } = createCrawlerClientHeaders({
        pinnedUserAgent: null,
        family,
        random: seededRandom(5),
      });

      const names = Object.keys(customHeaders);
      for (let read = 0; read < 10; read++) {
        expect(Object.keys(customHeaders)).toEqual(names);
        expect(identityOf(customHeaders['User-Agent']).family).toBe(family);
      }
    }
  });

  it('spreads the identity across the requests of one client', () => {
    const { userAgent, customHeaders } = createCrawlerClientHeaders({
      pinnedUserAgent: null,
      family: 'chrome',
      random: seededRandom(13),
    });

    expect(userAgent).toMatch(BROWSER_UA_PATTERN);
    expect(customHeaders).toHaveProperty('User-Agent');
    expect(customHeaders.Accept).toContain('text/html');
    expect(customHeaders['Accept-Language']).toContain('ko-KR');
    // Rotation is only possible because these are accessors: pal-crawl reads
    // `customHeaders` once per request.
    expect(
      Object.getOwnPropertyDescriptor(customHeaders, 'User-Agent')?.get,
    ).toEqual(expect.any(Function));
  });

  it('sends a static generic header set when the User-Agent is pinned', async () => {
    const { userAgent, customHeaders } = createCrawlerClientHeaders({
      pinnedUserAgent: 'LawCast/1.0 (Legislative Notice Crawler)',
    });

    expect(
      Object.getOwnPropertyDescriptor(customHeaders, 'User-Agent')?.get,
    ).toBeUndefined();

    const { headers, restore } = capturePalCrawlRequestHeaders();

    try {
      const client = new NsmLmSts({
        userAgent,
        timeout: 1000,
        retryCount: 1,
        customHeaders,
      });

      await client.search({ pageIndex: 1, pageSize: 1 });
    } finally {
      restore();
    }

    expect(headers[0]['User-Agent']).toBe(
      'LawCast/1.0 (Legislative Notice Crawler)',
    );
    expect(headers[0]).not.toHaveProperty('sec-ch-ua');
    expect(headers[0].Accept).toBe(APP_CONSTANTS.CRAWLING.HEADERS.Accept);
  });
});
