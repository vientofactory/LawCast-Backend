import { describe, expect, it } from '@jest/globals';
import createConfig from './app.config';

/**
 * Env parsing for the rerank leg of the semantic no-result gate. The factory
 * reads `process.env` directly, so each case brackets the variable to keep
 * the suite hermetic regardless of the developer's shell exports.
 */
describe('app.config semanticSearch.rerankCutoff', () => {
  const KEY = 'SEMANTIC_SEARCH_RERANK_CUTOFF';

  const cutoffWithEnv = (value: string | undefined): number | null => {
    const saved = process.env[KEY];
    try {
      if (value === undefined) {
        delete process.env[KEY];
      } else {
        process.env[KEY] = value;
      }
      return createConfig().semanticSearch.rerankCutoff;
    } finally {
      if (saved === undefined) {
        delete process.env[KEY];
      } else {
        process.env[KEY] = saved;
      }
    }
  };

  it('disables the leg when unset, blank, or non-numeric', () => {
    expect(cutoffWithEnv(undefined)).toBeNull();
    expect(cutoffWithEnv('')).toBeNull();
    expect(cutoffWithEnv('   ')).toBeNull();
    expect(cutoffWithEnv('abc')).toBeNull();
  });

  it('parses the calibrated cutoff, tolerating surrounding whitespace', () => {
    expect(cutoffWithEnv('-1')).toBe(-1);
    expect(cutoffWithEnv('  -1.0  ')).toBe(-1);
  });
});

/**
 * Env parsing for the aggregate semantic-search budget. Same bracketing
 * pattern: each case restores the shell's value so the suite stays hermetic.
 */
describe('app.config semanticSearch.totalTimeoutMs', () => {
  const TOTAL_KEY = 'SEMANTIC_SEARCH_TOTAL_TIMEOUT';
  const TIMEOUT_KEY = 'SEMANTIC_SEARCH_TIMEOUT';

  const totalWithEnv = (
    total: string | undefined,
    timeout: string | undefined,
  ): number => {
    const savedTotal = process.env[TOTAL_KEY];
    const savedTimeout = process.env[TIMEOUT_KEY];
    try {
      if (total === undefined) {
        delete process.env[TOTAL_KEY];
      } else {
        process.env[TOTAL_KEY] = total;
      }
      if (timeout === undefined) {
        delete process.env[TIMEOUT_KEY];
      } else {
        process.env[TIMEOUT_KEY] = timeout;
      }
      return createConfig().semanticSearch.totalTimeoutMs;
    } finally {
      if (savedTotal === undefined) {
        delete process.env[TOTAL_KEY];
      } else {
        process.env[TOTAL_KEY] = savedTotal;
      }
      if (savedTimeout === undefined) {
        delete process.env[TIMEOUT_KEY];
      } else {
        process.env[TIMEOUT_KEY] = savedTimeout;
      }
    }
  };

  it('parses an explicit budget, tolerating surrounding whitespace', () => {
    expect(totalWithEnv('15000', undefined)).toBe(15000);
    expect(totalWithEnv('  8000  ', undefined)).toBe(8000);
  });

  it('falls back to the per-window timeout when unset, blank, or invalid', () => {
    expect(totalWithEnv(undefined, undefined)).toBe(10000);
    expect(totalWithEnv(undefined, '7000')).toBe(7000);
    expect(totalWithEnv('', '7000')).toBe(7000);
    expect(totalWithEnv('   ', undefined)).toBe(10000);
    expect(totalWithEnv('abc', undefined)).toBe(10000);
  });

  it('falls back to the per-window timeout on non-positive values', () => {
    expect(totalWithEnv('0', undefined)).toBe(10000);
    expect(totalWithEnv('-5', undefined)).toBe(10000);
  });
});
