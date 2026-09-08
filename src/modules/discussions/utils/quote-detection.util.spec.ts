import { QuoteDetectionUtil } from './quote-detection.util';

describe('QuoteDetectionUtil', () => {
  it('extracts the existing discussion quote formats', () => {
    expect(
      QuoteDetectionUtil.extractReferencedSequences(
        '>>#1\n본문에 >> 2와 >#3을 인용합니다.',
      ),
    ).toEqual([1, 2, 3]);
  });

  it('deduplicates references and ignores invalid or embedded numbers', () => {
    expect(
      QuoteDetectionUtil.extractReferencedSequences(
        '번호 12, abc>>#4, >>#4, >>0, >>999999999999999999999',
      ),
    ).toEqual([4]);
  });
});
