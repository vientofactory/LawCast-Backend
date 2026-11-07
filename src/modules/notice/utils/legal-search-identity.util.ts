const LAW_NAME = /^[가-힣][가-힣·]{0,79}(?:법률|법)$/u;
const TYPO_NAME = /^[가-힣][가-힣·]{0,79}(?:법률|법|볍)$/u;
const BILL_SUFFIX =
  /(?:일부개정법률안|전부개정법률안|폐지법률안|제정법률안|개정법률안|법률안)$/u;

function compact(text: string): string {
  return text.normalize('NFC').replace(/\s+/gu, '');
}

export function parseNoticeNumber(query: string): number | undefined {
  const match = /^(?:의안번호\s*[:：]?\s*)?([1-9][0-9]{6})$/u.exec(
    query.trim(),
  );
  return match ? Number(match[1]) : undefined;
}

export function legalLookupPrefix(query: string): string | undefined {
  const name = compact(query);
  return TYPO_NAME.test(name) ? name[0] : undefined;
}

function singleJamoSubstitution(a: string, b: string): boolean {
  const left = Array.from(a.normalize('NFD'));
  const right = Array.from(b.normalize('NFD'));
  return (
    left.length === right.length &&
    left.filter((char, i) => char !== right[i]).length === 1
  );
}

export function selectLegalIdentities(
  query: string,
  titles: { noticeNum: number; subject: string }[],
  limit: number,
): { noticeNums: number[]; suggestedQuery?: string } {
  const name = compact(query);
  const noticeNums: number[] = [];
  const suggestions = new Map<string, string>();
  for (const row of titles) {
    const title = row.subject
      .normalize('NFC')
      .replace(/\s*\([^()]*\)\s*$/u, '')
      .trim();
    const subject = compact(title);
    if (!BILL_SUFFIX.test(subject)) continue;
    const stem = subject.replace(BILL_SUFFIX, '');
    // A bill titled with just "법률안" may already end in the formal law name.
    const identities = new Set([stem]);
    if (subject === stem + '법률안') identities.add(subject.slice(0, -1));
    if (LAW_NAME.test(name) && identities.has(name)) {
      if (noticeNums.length < limit) noticeNums.push(row.noticeNum);
      continue;
    }
    for (const candidate of identities) {
      if (
        LAW_NAME.test(candidate) &&
        candidate.length === name.length &&
        candidate.startsWith(name.slice(0, 2)) &&
        singleJamoSubstitution(candidate, name)
      ) {
        const display = title.replace(
          /\s*(?:일부\s*개정|전부\s*개정|폐지|제정|개정)?\s*법률안$/u,
          '',
        );
        suggestions.set(
          candidate,
          compact(display) === candidate ? display : candidate,
        );
      }
    }
  }
  if (noticeNums.length || suggestions.size !== 1) return { noticeNums };
  return { noticeNums, suggestedQuery: suggestions.values().next().value };
}
