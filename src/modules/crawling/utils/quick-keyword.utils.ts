import {
  type CachedNotice,
  type QuickKeywordSuggestionsCache,
} from '../../../types/cache.types';

const QUICK_KEYWORD_STOPWORDS = new Set([
  '가',
  '개정',
  '개정안',
  '국회',
  '관한',
  '관련',
  '규칙안',
  '대한',
  '등',
  '법률',
  '법률안',
  '법안',
  '발의',
  '및',
  '시행규칙',
  '시행규칙안',
  '시행령',
  '시행령안',
  '에',
  '의',
  '의안',
  '의안번호',
  '의원',
  '일부개정',
  '일부개정법률안',
  '일부개정안',
  '일부를',
  '일부법률안',
  '일부사항',
  '전부개정',
  '전부개정법률안',
  '전부개정안',
  '제',
  '제정',
  '제정법률안',
  '조례안',
  '중',
  '타법개정',
  '통해',
  '특별법',
  '특별법안',
  '기본법',
  '폐지',
  '폐지법률안',
  '지원',
  '위한',
  '공정화',
  '하기',
  '하는',
  '한',
]);

const QUICK_KEYWORD_PARTICLE_SUFFIXES = [
  '으로',
  '에서',
  '에게',
  '까지',
  '부터',
  '처럼',
  '보다',
  '마다',
  '에는',
  '에서',
  '의',
  '에',
  '은',
  '는',
  '이',
  '가',
  '을',
  '를',
  '와',
  '과',
  '도',
  '로',
] as const;

export function buildQuickKeywordSuggestionsCache(
  notices: CachedNotice[],
  sourceLimit: number,
): QuickKeywordSuggestionsCache {
  const ranked = new Map<
    string,
    { keyword: string; score: number; matchCount: number }
  >();

  const sourceNotices = notices.slice(0, sourceLimit);
  const total = sourceNotices.length;

  for (let index = 0; index < sourceNotices.length; index += 1) {
    const notice = sourceNotices[index];
    const recencyWeight = 1 + (total - index) / Math.max(1, total);
    const tokens = extractKeywordTokens(notice.subject);
    const uniqueTokens = new Set(tokens);

    for (const token of uniqueTokens) {
      const existing = ranked.get(token);
      if (existing) {
        existing.score += recencyWeight;
        existing.matchCount += 1;
        continue;
      }

      ranked.set(token, {
        keyword: token,
        score: recencyWeight,
        matchCount: 1,
      });
    }
  }

  const items = Array.from(ranked.values())
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      if (right.matchCount !== left.matchCount) {
        return right.matchCount - left.matchCount;
      }

      if (right.keyword.length !== left.keyword.length) {
        return right.keyword.length - left.keyword.length;
      }

      return left.keyword.localeCompare(right.keyword, 'ko');
    })
    .slice(0, 20)
    .map((item) => ({
      keyword: item.keyword,
      score: Number(item.score.toFixed(2)),
      matchCount: item.matchCount,
    }));

  return {
    items,
    updatedAt: new Date().toISOString(),
    sourceNoticeCount: sourceNotices.length,
  };
}

export function isAcceptableQuickKeywordToken(token: string): boolean {
  if (!token || QUICK_KEYWORD_STOPWORDS.has(token)) {
    return false;
  }

  if (token.endsWith('위원회') || token.endsWith('특별위원회')) {
    return false;
  }

  if (token.endsWith('의원') || token.includes('의원')) {
    return false;
  }

  if (/^[가-힣]{1,2}$/.test(token)) {
    return false;
  }

  if (
    /(등|사항|체계|정비|강화|확대|촉진|지원|관리|운영|활성화|공정화)$/.test(
      token,
    )
  ) {
    return false;
  }

  return true;
}

function extractKeywordTokens(subject: string): string[] {
  const matches = subject.match(/[A-Za-z]+|[0-9]+|[가-힣]+/g) ?? [];

  return matches
    .map((token) => token.trim())
    .map((token) => (/^[A-Za-z]+$/.test(token) ? token.toUpperCase() : token))
    .map((token) => normalizeQuickKeywordToken(token))
    .filter((token) => token.length >= 2)
    .filter((token) => !/^\d+$/.test(token))
    .filter((token) => isAcceptableQuickKeywordToken(token));
}

function normalizeQuickKeywordToken(token: string): string {
  if (!/[가-힣]/.test(token)) {
    return token;
  }

  let normalized = token;

  for (const suffix of QUICK_KEYWORD_PARTICLE_SUFFIXES) {
    if (normalized.length <= suffix.length + 1) {
      continue;
    }

    if (normalized.endsWith(suffix)) {
      normalized = normalized.slice(0, -suffix.length);
      break;
    }
  }

  return normalized;
}
