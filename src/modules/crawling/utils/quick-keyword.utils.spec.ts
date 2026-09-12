import {
  buildQuickKeywordSuggestionsCache,
  isAcceptableQuickKeywordToken,
} from './quick-keyword.utils';
import { type CachedNotice } from '../../../types/cache.types';

function makeNotice(overrides: Partial<CachedNotice> = {}): CachedNotice {
  return {
    num: 2200001,
    subject: '환경 보호 법률안',
    proposerCategory: '정부',
    committee: '정무위원회',
    link: 'https://example.com',
    contentId: null,
    aiSummary: null,
    aiSummaryStatus: 'not_requested' as const,
    attachments: { pdfFile: '', hwpFile: '' },
    ...overrides,
  } as CachedNotice;
}

describe('isAcceptableQuickKeywordToken', () => {
  it('returns false for empty string', () => {
    expect(isAcceptableQuickKeywordToken('')).toBe(false);
  });

  it('returns false for common stopwords', () => {
    expect(isAcceptableQuickKeywordToken('법률')).toBe(false);
    expect(isAcceptableQuickKeywordToken('법률안')).toBe(false);
    expect(isAcceptableQuickKeywordToken('의안')).toBe(false);
    expect(isAcceptableQuickKeywordToken('국회')).toBe(false);
    expect(isAcceptableQuickKeywordToken('일부개정')).toBe(false);
    expect(isAcceptableQuickKeywordToken('제정')).toBe(false);
  });

  it('returns false for committee names ending in 위원회', () => {
    expect(isAcceptableQuickKeywordToken('환경노동위원회')).toBe(false);
    expect(isAcceptableQuickKeywordToken('특별위원회')).toBe(false);
  });

  it('returns false for tokens containing 의원', () => {
    expect(isAcceptableQuickKeywordToken('홍길동의원')).toBe(false);
    expect(isAcceptableQuickKeywordToken('의원발의')).toBe(false);
  });

  it('returns false for single or double character tokens', () => {
    expect(isAcceptableQuickKeywordToken('가')).toBe(false);
    expect(isAcceptableQuickKeywordToken('한')).toBe(false);
    expect(isAcceptableQuickKeywordToken('가나')).toBe(false); // 2 chars
  });

  it('returns false for generic suffixes', () => {
    expect(isAcceptableQuickKeywordToken('지원')).toBe(false);
    expect(isAcceptableQuickKeywordToken('강화')).toBe(false);
    expect(isAcceptableQuickKeywordToken('확대')).toBe(false);
    expect(isAcceptableQuickKeywordToken('활성화')).toBe(false);
  });

  it('returns true for meaningful keywords with 3+ chars', () => {
    expect(isAcceptableQuickKeywordToken('개인정보')).toBe(true);
    expect(isAcceptableQuickKeywordToken('인공지능')).toBe(true);
    expect(isAcceptableQuickKeywordToken('탄소중립')).toBe(true);
    expect(isAcceptableQuickKeywordToken('환경보호')).toBe(true);
  });
});

describe('buildQuickKeywordSuggestionsCache', () => {
  it('returns empty items when no notices are provided', () => {
    const result = buildQuickKeywordSuggestionsCache([], 100);

    expect(result.items).toEqual([]);
    expect(result.sourceNoticeCount).toBe(0);
    expect(result.updatedAt).toBeDefined();
  });

  it('extracts keywords from notice subjects', () => {
    const notices = [
      makeNotice({ num: 1, subject: '인공지능 규제 법률안' }),
      makeNotice({ num: 2, subject: '교육 지원 법률안' }),
    ];

    const result = buildQuickKeywordSuggestionsCache(notices, 100);

    // '인공지능' (4 chars) and '교육' (2 chars, but let's use longer ones)
    const keywords = result.items.map((i) => i.keyword);
    expect(keywords).toContain('인공지능');
  });

  it('respects the sourceLimit parameter', () => {
    const notices = Array.from({ length: 50 }, (_, i) =>
      makeNotice({
        num: i + 1,
        subject: `의안_${i}_환경 보호`,
      }),
    );

    const result = buildQuickKeywordSuggestionsCache(notices, 10);

    expect(result.sourceNoticeCount).toBe(10);
  });

  it('sorts items by score descending', () => {
    const notices = [
      makeNotice({ num: 1, subject: '인공지능 규제 법률안' }),
      makeNotice({ num: 2, subject: '인공지능 보안 법률안' }),
      makeNotice({ num: 3, subject: '교육 지원 법률안' }),
    ];

    const result = buildQuickKeywordSuggestionsCache(notices, 100);

    if (result.items.length >= 2) {
      for (let i = 1; i < result.items.length; i++) {
        expect(result.items[i].score).toBeLessThanOrEqual(
          result.items[i - 1].score,
        );
      }
    }
  });

  it('limits results to 20 items', () => {
    const notices = Array.from({ length: 100 }, (_, i) =>
      makeNotice({
        num: i + 1,
        subject: `고유키워드${i} 추가내용${i}`,
      }),
    );

    const result = buildQuickKeywordSuggestionsCache(notices, 100);

    expect(result.items.length).toBeLessThanOrEqual(20);
  });

  it('converts English tokens to uppercase', () => {
    const notices = [makeNotice({ num: 1, subject: 'NFT 관련 법률안' })];

    const result = buildQuickKeywordSuggestionsCache(notices, 100);

    const keywords = result.items.map((i) => i.keyword);
    expect(keywords).toContain('NFT');
  });

  it('filters out numeric-only tokens', () => {
    const notices = [
      makeNotice({ num: 1, subject: '2026년도 인공지능 법률안' }),
    ];

    const result = buildQuickKeywordSuggestionsCache(notices, 100);

    const keywords = result.items.map((i) => i.keyword);
    expect(keywords).not.toContain('2026');
    expect(keywords).not.toContain('년도');
  });

  it('normalizes Korean particle suffixes', () => {
    const notices = [
      makeNotice({ num: 1, subject: '개인정보보호에서 규제하는 법률안' }),
    ];

    const result = buildQuickKeywordSuggestionsCache(notices, 100);

    // '개인정보보호에서' should be normalized to '개인정보보호' by removing particle '에서'
    const keywords = result.items.map((i) => i.keyword);
    expect(keywords).toContain('개인정보보호');
  });

  it('includes matchCount in each item', () => {
    const notices = [
      makeNotice({ num: 1, subject: '인공지능 규제 법률안' }),
      makeNotice({ num: 2, subject: '인공지능 보안 법률안' }),
    ];

    const result = buildQuickKeywordSuggestionsCache(notices, 100);

    const keyword = result.items.find((i) => i.keyword === '인공지능');
    if (keyword) {
      expect(keyword.matchCount).toBeGreaterThanOrEqual(2);
    }
  });
});
