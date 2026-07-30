export type CompetentAuthorityKind = 'committee' | 'ministry' | 'agency';

interface CompetentAuthorityEntry {
  name: string;
  kind: CompetentAuthorityKind;
}

export interface CompetentAuthorityRecoveryOptions {
  preferredKinds?: readonly CompetentAuthorityKind[];
  onlyWhenIncomplete?: boolean;
  incompleteSuffixes?: readonly string[];
  minLookupLength?: number;
}

const DEFAULT_INCOMPLETE_SUFFIXES = [
  '위원회',
  '특별위원회',
  '부',
  '처',
  '청',
  '원',
  '실',
  '국',
] as const;

const DEFAULT_PREFERRED_KINDS: readonly CompetentAuthorityKind[] = [
  'committee',
  'ministry',
  'agency',
];

// Source references:
// - National Assembly committees: https://ko.wikipedia.org/wiki/대한민국_국회_상임위원회
// - Government organizations portal: https://www.gov.kr/portal/orgInfo
const COMPETENT_AUTHORITY_ENTRIES: readonly CompetentAuthorityEntry[] = [
  // National Assembly committees
  { name: '국회운영위원회', kind: 'committee' },
  { name: '법제사법위원회', kind: 'committee' },
  { name: '정무위원회', kind: 'committee' },
  { name: '기획재정위원회', kind: 'committee' },
  { name: '교육위원회', kind: 'committee' },
  { name: '과학기술정보방송통신위원회', kind: 'committee' },
  { name: '외교통일위원회', kind: 'committee' },
  { name: '국방위원회', kind: 'committee' },
  { name: '행정안전위원회', kind: 'committee' },
  { name: '문화체육관광위원회', kind: 'committee' },
  { name: '농림축산식품해양수산위원회', kind: 'committee' },
  { name: '산업통상자원중소벤처기업위원회', kind: 'committee' },
  { name: '보건복지위원회', kind: 'committee' },
  { name: '환경노동위원회', kind: 'committee' },
  { name: '기후에너지환경노동위원회', kind: 'committee' },
  { name: '국토교통위원회', kind: 'committee' },
  { name: '정보위원회', kind: 'committee' },
  { name: '여성가족위원회', kind: 'committee' },
  { name: '성평등가족위원회', kind: 'committee' },
  { name: '예산결산특별위원회', kind: 'committee' },

  // Ministries
  { name: '기획재정부', kind: 'ministry' },
  { name: '교육부', kind: 'ministry' },
  { name: '과학기술정보통신부', kind: 'ministry' },
  { name: '외교부', kind: 'ministry' },
  { name: '통일부', kind: 'ministry' },
  { name: '법무부', kind: 'ministry' },
  { name: '국방부', kind: 'ministry' },
  { name: '행정안전부', kind: 'ministry' },
  { name: '국가보훈부', kind: 'ministry' },
  { name: '문화체육관광부', kind: 'ministry' },
  { name: '농림축산식품부', kind: 'ministry' },
  { name: '산업통상자원부', kind: 'ministry' },
  { name: '보건복지부', kind: 'ministry' },
  { name: '환경부', kind: 'ministry' },
  { name: '고용노동부', kind: 'ministry' },
  { name: '여성가족부', kind: 'ministry' },
  { name: '성평등가족부', kind: 'ministry' },
  { name: '국토교통부', kind: 'ministry' },
  { name: '해양수산부', kind: 'ministry' },
  { name: '중소벤처기업부', kind: 'ministry' },

  // Agencies / commissions frequently seen in committee jurisdictions
  { name: '국무조정실', kind: 'agency' },
  { name: '국무총리비서실', kind: 'agency' },
  { name: '법제처', kind: 'agency' },
  { name: '인사혁신처', kind: 'agency' },
  { name: '식품의약품안전처', kind: 'agency' },
  { name: '대통령비서실', kind: 'agency' },
  { name: '국가안보실', kind: 'agency' },
  { name: '대통령경호처', kind: 'agency' },
  { name: '국가정보원', kind: 'agency' },
  { name: '공정거래위원회', kind: 'agency' },
  { name: '금융위원회', kind: 'agency' },
  { name: '국민권익위원회', kind: 'agency' },
  { name: '방송통신위원회', kind: 'agency' },
  { name: '원자력안전위원회', kind: 'agency' },
  { name: '국가인권위원회', kind: 'agency' },
  { name: '중앙선거관리위원회', kind: 'agency' },
  { name: '검찰청', kind: 'agency' },
  { name: '경찰청', kind: 'agency' },
  { name: '소방청', kind: 'agency' },
  { name: '해양경찰청', kind: 'agency' },
  { name: '국세청', kind: 'agency' },
  { name: '관세청', kind: 'agency' },
  { name: '조달청', kind: 'agency' },
  { name: '통계청', kind: 'agency' },
  { name: '기상청', kind: 'agency' },
  { name: '질병관리청', kind: 'agency' },
  { name: '특허청', kind: 'agency' },
];

const NORMALIZED_TO_ENTRY = new Map<string, CompetentAuthorityEntry>();

for (const entry of COMPETENT_AUTHORITY_ENTRIES) {
  const key = normalizeAuthorityToken(entry.name);
  if (!NORMALIZED_TO_ENTRY.has(key)) {
    NORMALIZED_TO_ENTRY.set(key, entry);
  }
}

const AUTHORITY_ALIASES = new Map<string, string>([
  ['법사위', '법제사법위원회'],
  ['정무위', '정무위원회'],
  ['기재위', '기획재정위원회'],
  ['교육위', '교육위원회'],
  ['과방위', '과학기술정보방송통신위원회'],
  ['외통위', '외교통일위원회'],
  ['국방위', '국방위원회'],
  ['행안위', '행정안전위원회'],
  ['문체위', '문화체육관광위원회'],
  ['농해수위', '농림축산식품해양수산위원회'],
  ['산자위', '산업통상자원중소벤처기업위원회'],
  ['복지위', '보건복지위원회'],
  ['환노위', '환경노동위원회'],
  ['기후환노위', '기후에너지환경노동위원회'],
  ['국토위', '국토교통위원회'],
  ['정보위', '정보위원회'],
  ['여가위', '여성가족위원회'],
  ['성평위', '성평등가족위원회'],
  ['예결위', '예산결산특별위원회'],
  ['과기정통부', '과학기술정보통신부'],
  ['문체부', '문화체육관광부'],
  ['농식품부', '농림축산식품부'],
  ['산자부', '산업통상자원부'],
  ['복지부', '보건복지부'],
  ['행안부', '행정안전부'],
  ['여가부', '여성가족부'],
]);

function normalizeAuthorityToken(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, '')
    .replace(/[()[\]{}<>.,·ㆍ\-_/]/g, '');
}

function hasKnownSuffix(value: string, suffixes: readonly string[]): boolean {
  return suffixes.some((suffix) => value.endsWith(suffix));
}

function getKindPriority(
  kind: CompetentAuthorityKind,
  kinds: readonly CompetentAuthorityKind[],
): number {
  const index = kinds.indexOf(kind);
  if (index < 0) {
    return 0;
  }

  return Math.max(1, kinds.length - index) * 10;
}

function rankCandidates(
  normalizedInput: string,
  preferredKinds: readonly CompetentAuthorityKind[],
): Array<{ name: string; score: number }> {
  const ranked: Array<{ name: string; score: number }> = [];

  for (const entry of COMPETENT_AUTHORITY_ENTRIES) {
    const normalizedName = normalizeAuthorityToken(entry.name);
    let score = 0;

    if (normalizedName === normalizedInput) {
      score += 100;
    }

    if (normalizedName.startsWith(normalizedInput)) {
      score += 80;
    } else if (normalizedName.includes(normalizedInput)) {
      score += 40;
    }

    score += getKindPriority(entry.kind, preferredKinds);

    if (score <= 0) {
      continue;
    }

    ranked.push({ name: entry.name, score });
  }

  ranked.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }

    if (left.name.length !== right.name.length) {
      return left.name.length - right.name.length;
    }

    return left.name.localeCompare(right.name, 'ko');
  });

  return ranked;
}

export function isIncompleteCompetentAuthorityName(
  value: string,
  options?: Pick<
    CompetentAuthorityRecoveryOptions,
    'incompleteSuffixes' | 'minLookupLength'
  >,
): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  const normalized = normalizeAuthorityToken(trimmed);
  const minLookupLength = Math.max(2, options?.minLookupLength ?? 2);
  if (normalized.length < minLookupLength) {
    return false;
  }

  if (NORMALIZED_TO_ENTRY.has(normalized)) {
    return false;
  }

  if (AUTHORITY_ALIASES.has(normalized)) {
    return true;
  }

  const suffixes = options?.incompleteSuffixes ?? DEFAULT_INCOMPLETE_SUFFIXES;
  return !hasKnownSuffix(trimmed, suffixes);
}

export function recoverCompetentAuthorityName(
  value: string,
  options?: CompetentAuthorityRecoveryOptions,
): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }

  const normalized = normalizeAuthorityToken(trimmed);
  const exact = NORMALIZED_TO_ENTRY.get(normalized);
  if (exact) {
    return exact.name;
  }

  const alias = AUTHORITY_ALIASES.get(normalized);
  if (alias) {
    return alias;
  }

  const minLookupLength = Math.max(2, options?.minLookupLength ?? 2);
  if (normalized.length < minLookupLength) {
    return trimmed;
  }

  const onlyWhenIncomplete = options?.onlyWhenIncomplete ?? true;
  if (
    onlyWhenIncomplete &&
    !isIncompleteCompetentAuthorityName(trimmed, {
      incompleteSuffixes: options?.incompleteSuffixes,
      minLookupLength,
    })
  ) {
    return trimmed;
  }

  const preferredKinds = options?.preferredKinds ?? DEFAULT_PREFERRED_KINDS;
  const ranked = rankCandidates(normalized, preferredKinds);
  if (ranked.length === 0) {
    return trimmed;
  }

  const topScore = ranked[0].score;
  const topCandidates = ranked.filter(
    (candidate) => candidate.score === topScore,
  );

  if (topCandidates.length === 1) {
    return topCandidates[0].name;
  }

  return trimmed;
}

export function recoverOptionalCompetentAuthorityName(
  value: string | null | undefined,
  options?: CompetentAuthorityRecoveryOptions,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  return recoverCompetentAuthorityName(trimmed, options);
}
