import { APP_CONSTANTS } from '../config/app.config';

const DEFAULT_HTML_FETCH_REDIRECT: RequestRedirect = 'follow';
const DEFAULT_HTML_FETCH_TIMEOUT_MS = APP_CONSTANTS.CRAWLING.TIMEOUT;

export function buildStandardHtmlFetchHeaders(
  userAgent: string,
  customHeaders?: HeadersInit,
): HeadersInit {
  return {
    ...APP_CONSTANTS.CRAWLING.HEADERS,
    'User-Agent': userAgent,
    ...(customHeaders ?? {}),
  };
}

export async function fetchHtmlPage(
  url: string,
  options: {
    userAgent: string;
    customHeaders?: HeadersInit;
    timeoutMs?: number;
    redirect?: RequestRedirect;
  },
): Promise<Response> {
  return globalThis.fetch(url, {
    method: 'GET',
    headers: buildStandardHtmlFetchHeaders(
      options.userAgent,
      options.customHeaders,
    ),
    redirect: options.redirect ?? DEFAULT_HTML_FETCH_REDIRECT,
    signal: AbortSignal.timeout(
      options.timeoutMs ?? DEFAULT_HTML_FETCH_TIMEOUT_MS,
    ),
  });
}
