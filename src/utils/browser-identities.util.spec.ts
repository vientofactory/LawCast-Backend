import {
  BROWSER_FAMILIES,
  BROWSER_IDENTITIES,
  isChromiumFamily,
  pickBrowserFamily,
  pickBrowserIdentity,
  pickBrowserIdentityInFamily,
  type BrowserFamily,
  type BrowserIdentity,
} from './browser-identities.util';

/** The shape every real browser User-Agent starts with. */
const BROWSER_UA_PREFIX = /^Mozilla\/5\.0 \(/;

/** Platform token expected inside the User-Agent of each platform. */
const PLATFORM_UA_TOKEN: Record<BrowserIdentity['platform'], RegExp> = {
  Windows: /Windows NT 10\.0/,
  macOS: /Macintosh; Intel Mac OS X/,
  Linux: /X11; Linux x86_64/,
  Android: /Linux; Android \d+/,
  iOS: /iPhone; CPU iPhone OS/,
};

describe('browser identity pool', () => {
  it('is non-empty and covers every family', () => {
    expect(BROWSER_IDENTITIES.length).toBeGreaterThanOrEqual(4);

    const families = new Set(BROWSER_IDENTITIES.map((entry) => entry.family));
    for (const family of BROWSER_FAMILIES) {
      expect(families.has(family)).toBe(true);
    }
  });

  it('carries only real browser User-Agents', () => {
    for (const identity of BROWSER_IDENTITIES) {
      expect(identity.userAgent).toMatch(BROWSER_UA_PREFIX);
      expect(identity.userAgent).toMatch(PLATFORM_UA_TOKEN[identity.platform]);
      // A product token in the pool would reintroduce the block this exists to
      // avoid (`agent_memories/32-nsm-ua-block-and-probe-storm/`).
      expect(identity.userAgent).not.toMatch(/LawCast/i);
    }
  });

  it('keeps the version in the User-Agent equal to the client-hint version', () => {
    for (const identity of BROWSER_IDENTITIES) {
      switch (identity.family) {
        case 'chrome':
        case 'edge':
          // Chrome freezes the version in the UA to `MAJOR.0.0.0`.
          expect(identity.userAgent).toContain(
            `Chrome/${identity.significantVersion}.0.0.0`,
          );
          break;
        case 'firefox':
          expect(identity.userAgent).toContain(
            `rv:${identity.significantVersion}`,
          );
          expect(identity.userAgent).toContain(
            `Firefox/${identity.significantVersion}`,
          );
          break;
        case 'safari':
          expect(identity.userAgent).toContain(
            `Version/${identity.significantVersion}`,
          );
          break;
      }
    }
  });

  it('marks exactly the mobile identities as mobile', () => {
    for (const identity of BROWSER_IDENTITIES) {
      expect(identity.userAgent.includes('Mobile')).toBe(identity.mobile);
    }
  });

  it('only marks Chrome and Edge as Chromium', () => {
    for (const identity of BROWSER_IDENTITIES) {
      const expected =
        identity.family === 'chrome' || identity.family === 'edge';
      expect(isChromiumFamily(identity.family)).toBe(expected);
    }
  });
});

describe('pickBrowserIdentity', () => {
  it('spans the pool as the random source moves', () => {
    expect(pickBrowserIdentity(() => 0)).toBe(BROWSER_IDENTITIES[0]);
    expect(pickBrowserIdentity(() => 0.99)).toBe(
      BROWSER_IDENTITIES[BROWSER_IDENTITIES.length - 1],
    );
    expect(pickBrowserIdentity(() => 0.5)).toBe(
      BROWSER_IDENTITIES[Math.floor(BROWSER_IDENTITIES.length / 2)],
    );
  });

  it('clamps a random source that returns 1', () => {
    expect(pickBrowserIdentity(() => 1)).toBe(
      BROWSER_IDENTITIES[BROWSER_IDENTITIES.length - 1],
    );
  });

  it('can reach every identity in the pool', () => {
    const reached = new Set<string>();
    const steps = 400;

    for (let step = 0; step < steps; step++) {
      reached.add(pickBrowserIdentity(() => step / steps).userAgent);
    }

    expect(reached.size).toBe(BROWSER_IDENTITIES.length);
  });
});

describe('pickBrowserIdentityInFamily', () => {
  it('only returns identities of the requested family', () => {
    for (const family of BROWSER_FAMILIES) {
      for (let step = 0; step < 20; step++) {
        const identity = pickBrowserIdentityInFamily(family, () => step / 20);
        expect(identity.family).toBe(family);
      }
    }
  });

  it('covers every identity of the family', () => {
    for (const family of BROWSER_FAMILIES) {
      const expected = BROWSER_IDENTITIES.filter(
        (identity) => identity.family === family,
      ).map((identity) => identity.userAgent);
      const reached = new Set<string>();

      for (let step = 0; step < 200; step++) {
        reached.add(
          pickBrowserIdentityInFamily(family, () => step / 200).userAgent,
        );
      }

      expect([...reached].sort()).toEqual([...expected].sort());
    }
  });

  it('falls back to the whole pool for an unknown family', () => {
    const identity = pickBrowserIdentityInFamily(
      'unknown' as BrowserFamily,
      () => 0,
    );

    expect(BROWSER_IDENTITIES).toContain(identity);
  });
});

describe('pickBrowserFamily', () => {
  it('spans the families', () => {
    expect(pickBrowserFamily(() => 0)).toBe(BROWSER_FAMILIES[0]);
    expect(pickBrowserFamily(() => 0.99)).toBe(
      BROWSER_FAMILIES[BROWSER_FAMILIES.length - 1],
    );
  });
});
