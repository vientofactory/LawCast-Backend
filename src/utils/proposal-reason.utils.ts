export function canonicalizeProposalReason(
  value: string | null | undefined,
): string | null {
  const normalized = value
    ?.replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .join('\n')
    .trim();

  return normalized && normalized.length > 0 ? normalized : null;
}
