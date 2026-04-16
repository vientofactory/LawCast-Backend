export function isProductionNodeEnv(nodeEnv?: string): boolean {
  return nodeEnv === 'production';
}

export function sanitizeSearchQuery(
  search: string | undefined,
  maxLength: number,
): string | undefined {
  if (!search) {
    return undefined;
  }

  const withoutControlChars = Array.from(search)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join('');

  const sanitized = withoutControlChars
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);

  return sanitized.length > 0 ? sanitized : undefined;
}
