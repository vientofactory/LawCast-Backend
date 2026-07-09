export function parsePositiveInteger(raw?: string): number | undefined {
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

export function parseIsoDate(raw?: string): Date | undefined {
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }

  return parsed;
}
