import { afterEach, describe, expect, it } from '@jest/globals';
import {
  CRAWLER_SOURCE,
  CrawlerActivationError,
  assertAtLeastOneCrawlerEnabled,
  getCrawlerActivationState,
  isCrawlerEnabled,
  isLikmsNsmSourceEnabled,
  isNsmCrawlerEnabled,
  isNsmPendingStreamRedundant,
  isPalCrawlerEnabled,
  isSnapshotSourceCaptureEnabled,
} from './crawler-activation.utils';

describe('crawler-activation.utils', () => {
  afterEach(() => {
    delete process.env.CRAWLING_PAL_ENABLED;
    delete process.env.CRAWLING_NSM_ENABLED;
    delete process.env.CRAWLING_NSM_SOURCE;
  });

  describe('isPalCrawlerEnabled / isNsmCrawlerEnabled', () => {
    it('default to enabled when the env var is not set', () => {
      expect(isPalCrawlerEnabled()).toBe(true);
      expect(isNsmCrawlerEnabled()).toBe(true);
    });

    it.each(['1', 'true', 'TRUE', 'yes', 'on', ' true '])(
      'treats CRAWLING_PAL_ENABLED=%s as enabled',
      (value) => {
        process.env.CRAWLING_PAL_ENABLED = value;
        expect(isPalCrawlerEnabled()).toBe(true);
      },
    );

    it.each(['0', 'false', 'FALSE', 'no', 'off', ' false '])(
      'treats CRAWLING_PAL_ENABLED=%s as disabled',
      (value) => {
        process.env.CRAWLING_PAL_ENABLED = value;
        expect(isPalCrawlerEnabled()).toBe(false);
      },
    );

    it.each(['0', 'false', 'no', 'off'])(
      'treats CRAWLING_NSM_ENABLED=%s as disabled',
      (value) => {
        process.env.CRAWLING_NSM_ENABLED = value;
        expect(isNsmCrawlerEnabled()).toBe(false);
      },
    );

    it('falls back to enabled for unrecognized values', () => {
      process.env.CRAWLING_PAL_ENABLED = 'banana';
      process.env.CRAWLING_NSM_ENABLED = '';
      expect(isPalCrawlerEnabled()).toBe(true);
      expect(isNsmCrawlerEnabled()).toBe(true);
    });

    it('keeps the two sources independent', () => {
      process.env.CRAWLING_PAL_ENABLED = 'false';
      expect(isPalCrawlerEnabled()).toBe(false);
      expect(isNsmCrawlerEnabled()).toBe(true);

      process.env.CRAWLING_NSM_ENABLED = 'false';
      expect(isPalCrawlerEnabled()).toBe(false);
      expect(isNsmCrawlerEnabled()).toBe(false);
    });

    it('reads the env var on every call so it can be toggled at runtime', () => {
      expect(isPalCrawlerEnabled()).toBe(true);

      process.env.CRAWLING_PAL_ENABLED = 'false';
      expect(isPalCrawlerEnabled()).toBe(false);

      process.env.CRAWLING_PAL_ENABLED = 'true';
      expect(isPalCrawlerEnabled()).toBe(true);
    });
  });

  describe('isCrawlerEnabled', () => {
    it('maps each source to its own flag', () => {
      process.env.CRAWLING_PAL_ENABLED = 'false';
      expect(isCrawlerEnabled(CRAWLER_SOURCE.PAL)).toBe(false);
      expect(isCrawlerEnabled(CRAWLER_SOURCE.NSM)).toBe(true);

      process.env.CRAWLING_NSM_ENABLED = 'false';
      expect(isCrawlerEnabled(CRAWLER_SOURCE.NSM)).toBe(false);
    });
  });

  describe('isLikmsNsmSourceEnabled', () => {
    it('defaults to the NSM source when unset', () => {
      expect(isLikmsNsmSourceEnabled()).toBe(false);
    });

    it.each(['likms', 'LIKMS', ' Likms '])(
      'switches to the LIKMS source for CRAWLING_NSM_SOURCE=%s',
      (value) => {
        process.env.CRAWLING_NSM_SOURCE = value;
        expect(isLikmsNsmSourceEnabled()).toBe(true);
      },
    );

    it.each(['nsm', '', 'banana', '1', 'true'])(
      'keeps the NSM source for CRAWLING_NSM_SOURCE=%s',
      (value) => {
        process.env.CRAWLING_NSM_SOURCE = value;
        expect(isLikmsNsmSourceEnabled()).toBe(false);
      },
    );

    it('reads the env var on every call so it can be toggled at runtime', () => {
      expect(isLikmsNsmSourceEnabled()).toBe(false);

      process.env.CRAWLING_NSM_SOURCE = 'likms';
      expect(isLikmsNsmSourceEnabled()).toBe(true);

      process.env.CRAWLING_NSM_SOURCE = 'nsm';
      expect(isLikmsNsmSourceEnabled()).toBe(false);
    });
  });

  describe('isSnapshotSourceCaptureEnabled', () => {
    it('follows the likms source even with the NSM portal crawler disabled', () => {
      process.env.CRAWLING_NSM_SOURCE = 'likms';
      process.env.CRAWLING_NSM_ENABLED = 'false';

      expect(isSnapshotSourceCaptureEnabled()).toBe(true);
    });

    it('follows the NSM enable flag when the NSM portal is the source', () => {
      expect(isSnapshotSourceCaptureEnabled()).toBe(true);

      process.env.CRAWLING_NSM_ENABLED = 'false';
      expect(isSnapshotSourceCaptureEnabled()).toBe(false);
    });
  });

  describe('isNsmPendingStreamRedundant', () => {
    it('keeps the pending stream for the NSM portal', () => {
      expect(isNsmPendingStreamRedundant()).toBe(false);

      process.env.CRAWLING_NSM_SOURCE = 'nsm';
      expect(isNsmPendingStreamRedundant()).toBe(false);
    });

    it('skips it for the LIKMS source, which filters the same list client-side', () => {
      process.env.CRAWLING_NSM_SOURCE = 'likms';

      expect(isNsmPendingStreamRedundant()).toBe(true);
    });

    it('reads the source on every call so it can be toggled at runtime', () => {
      expect(isNsmPendingStreamRedundant()).toBe(false);

      process.env.CRAWLING_NSM_SOURCE = 'likms';
      expect(isNsmPendingStreamRedundant()).toBe(true);

      delete process.env.CRAWLING_NSM_SOURCE;
      expect(isNsmPendingStreamRedundant()).toBe(false);
    });
  });

  describe('getCrawlerActivationState', () => {
    it('reports anyEnabled=false only when both are disabled', () => {
      expect(getCrawlerActivationState()).toEqual({
        pal: true,
        nsm: true,
        anyEnabled: true,
      });

      process.env.CRAWLING_PAL_ENABLED = 'false';
      expect(getCrawlerActivationState()).toEqual({
        pal: false,
        nsm: true,
        anyEnabled: true,
      });

      process.env.CRAWLING_NSM_ENABLED = 'false';
      expect(getCrawlerActivationState()).toEqual({
        pal: false,
        nsm: false,
        anyEnabled: false,
      });
    });
  });

  describe('assertAtLeastOneCrawlerEnabled', () => {
    it('returns the state when at least one crawler is enabled', () => {
      expect(assertAtLeastOneCrawlerEnabled()).toEqual({
        pal: true,
        nsm: true,
        anyEnabled: true,
      });

      process.env.CRAWLING_PAL_ENABLED = 'false';
      expect(assertAtLeastOneCrawlerEnabled()).toEqual({
        pal: false,
        nsm: true,
        anyEnabled: true,
      });
    });

    it('throws CrawlerActivationError when both crawlers are disabled', () => {
      process.env.CRAWLING_PAL_ENABLED = 'false';
      process.env.CRAWLING_NSM_ENABLED = 'false';

      expect(() => assertAtLeastOneCrawlerEnabled()).toThrow(
        CrawlerActivationError,
      );
      expect(() => assertAtLeastOneCrawlerEnabled()).toThrow(
        /At least one crawler must be enabled/,
      );
    });
  });
});
