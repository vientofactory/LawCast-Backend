export function normalizeNoticeNum(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : Number.parseInt(String(value ?? '').trim(), 10);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
