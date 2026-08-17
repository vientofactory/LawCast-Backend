export function canonicalizeProposalReason(
  value: string | null | undefined,
): string | null {
  const normalized = value
    ?.replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .split('\n')
    .map((line) =>
      line
        .replace(/[\u200b\u2060]/gu, '')
        .replace(/\s+/gu, ' ')
        .trim(),
    )
    .join('\n')
    .trim();

  return normalized && normalized.length > 0 ? normalized : null;
}

export function canonicalizeProposalReasonForComparison(
  value: string | null | undefined,
): string | null {
  return canonicalizeProposalReason(value)?.replace(/\s+/gu, ' ') ?? null;
}
