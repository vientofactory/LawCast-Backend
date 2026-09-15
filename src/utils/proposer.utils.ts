/**
 * Extracts and normalizes proposer names from Korean legislative notice proposer
 * strings (e.g. "윤한홍의원 등 10인", "김철수 의원 등 5인", "홍길동의원", "정부").
 */

/**
 * Extracts all proposer names (대표발의자/제안자) from a proposer string.
 *
 * Examples:
 * - "윤한홍의원 등 10인" -> ["윤한홍"]
 * - "윤한홍 의원 등 10인" -> ["윤한홍"]
 * - "윤한홍의원등 10인" -> ["윤한홍"]
 * - "윤한홍의원등10인" -> ["윤한홍"]
 * - "김철수 의원 외 12인" -> ["김철수"]
 * - "이영희의원 등 5명" -> ["이영희"]
 * - "김용민의원ㆍ박은정의원 등 12인" -> ["김용민", "박은정"]
 * - "홍길동의원" -> ["홍길동"]
 * - "홍길동 의원" -> ["홍길동"]
 * - "정부" -> ["정부"]
 * - "법무부장관" -> ["법무부장관"]
 * - "환경노동위원장" -> ["환경노동위원장"]
 * - "제안자목록 홍길동의원 등 10인" -> ["홍길동"]
 *
 * @param raw Proposer string or null/undefined
 * @returns Array of cleaned proposer names, or empty array
 */
export function extractProposerName(raw: string | null | undefined): string[] {
  if (!raw || typeof raw !== 'string') {
    return [];
  }

  let cleaned = raw.trim();
  if (!cleaned) {
    return [];
  }

  // Strip prefixes like "제안자목록", "제안자:", "발의자:"
  cleaned = cleaned
    .replace(/^(?:제안자목록|제안자\s*[:：]|발의자\s*[:：])\s*/u, '')
    .trim();

  // Pattern 1: "OOO의원 등 O인", "OOO의원ㆍOOO의원 외 O명", etc.
  const sponsorListMatch = cleaned.match(
    /^(.+?)\s*(?:등|외)\s*\d+\s*(?:인|명)\s*$/u,
  );
  if (sponsorListMatch && sponsorListMatch[1]) {
    return parseMultipleProposers(sponsorListMatch[1]);
  }

  // Pattern 2: "OOO의원", "OOO 의원"
  const singleLawmakerMatch = cleaned.match(/^([^\s()]+?)\s*의원\s*$/u);
  if (singleLawmakerMatch && singleLawmakerMatch[1]) {
    return [singleLawmakerMatch[1].trim()];
  }

  // Pattern 3: Fallback - return cleaned string (e.g. "정부", "법무부장관", "대통령", "위원장")
  return [cleaned];
}

/**
 * Parses a potentially multi-proposer string separated by "ㆍ" (middle dot)
 * into individual names, stripping trailing "의원" from each.
 *
 * - "김용민의원ㆍ박은정의원" -> ["김용민", "박은정"]
 * - "윤한홍의원" -> ["윤한홍"]
 * - "김철수" -> ["김철수"]
 */
function parseMultipleProposers(raw: string): string[] {
  const parts = raw.split('ㆍ');
  const names: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const name = trimmed.replace(/\s*의원\s*$/u, '').trim();
    if (name) {
      names.push(name);
    }
  }
  return names;
}

/**
 * Extracts the proposer string embedded inside a bill title (subject) and returns
 * all proposer names.
 *
 * Examples:
 * - "[2218288] 조세특례제한법 일부개정법률안(윤한홍의원 등 10인)" -> ["윤한홍"]
 * - "상법 일부개정법률안 (김철수의원 외 5명)" -> ["김철수"]
 * - "지방세법 일부개정법률안(정부)" -> ["정부"]
 * - "형사소송법 일부개정법률안(김용민의원ㆍ박은정의원 등 12인)" -> ["김용민", "박은정"]
 *
 * @param subject Notice subject/title string or null/undefined
 * @returns Array of proposer names extracted from parenthesis in subject, or empty array
 */
export function extractProposerFromSubject(
  subject: string | null | undefined,
): string[] {
  if (!subject || typeof subject !== 'string') {
    return [];
  }

  const trimmed = subject.trim();
  if (!trimmed) {
    return [];
  }

  // Look for trailing parenthesis e.g. (윤한홍의원 등 10인) or (정부)
  const parenMatch = trimmed.match(/\(([^()]+)\)\s*(?:\(수정\))?\s*$/u);
  if (parenMatch && parenMatch[1]) {
    const inside = parenMatch[1].trim();
    // Only extract if it looks like a proposer (contains 의원, 등/외, 정부, 장관, 위원장, etc.)
    if (
      /의원/u.test(inside) ||
      /(?:등|외)\s*\d+\s*(?:인|명)/u.test(inside) ||
      /^(?:정부|대통령|.*장관|.*위원장)$/u.test(inside)
    ) {
      return extractProposerName(inside);
    }
  }

  return [];
}
