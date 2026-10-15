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
