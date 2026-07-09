export function findPrimaryFrontendUrl(
  frontendUrls: string[] | undefined,
): string | null {
  return frontendUrls?.find((url) => !!url?.trim()) ?? null;
}

export function buildFrontendUrl(
  frontendUrls: string[] | undefined,
  path: string,
  params?: Record<string, string>,
): string | null {
  const primaryFrontendUrl = findPrimaryFrontendUrl(frontendUrls);
  if (!primaryFrontendUrl) {
    return null;
  }

  const normalizedBaseUrl = primaryFrontendUrl.replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const queryString = params
    ? `?${Object.entries(params)
        .map(
          ([key, value]) =>
            `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
        )
        .join('&')}`
    : '';

  return `${normalizedBaseUrl}${normalizedPath}${queryString}`;
}
