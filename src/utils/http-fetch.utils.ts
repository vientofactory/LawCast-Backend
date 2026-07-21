import axios, { AxiosResponse } from 'axios';

import { APP_CONSTANTS } from '../config/app.config';

const DEFAULT_HTML_FETCH_REDIRECT: RequestRedirect = 'follow';
const DEFAULT_HTML_FETCH_TIMEOUT_MS = APP_CONSTANTS.CRAWLING.TIMEOUT;

function normalizeHeaders(headers?: HeadersInit): Record<string, string> {
  if (!headers) {
    return {};
  }

  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }

  return { ...headers };
}

export function buildStandardHtmlFetchHeaders(
  userAgent: string,
  customHeaders?: HeadersInit,
): Record<string, string> {
  return {
    ...APP_CONSTANTS.CRAWLING.HEADERS,
    'User-Agent': userAgent,
    ...normalizeHeaders(customHeaders),
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
): Promise<AxiosResponse<string>> {
  const redirect = options.redirect ?? DEFAULT_HTML_FETCH_REDIRECT;
  const headers = buildStandardHtmlFetchHeaders(
    options.userAgent,
    options.customHeaders,
  );

  return axios.get<string>(url, {
    headers,
    timeout: options.timeoutMs ?? DEFAULT_HTML_FETCH_TIMEOUT_MS,
    responseType: 'text',
    validateStatus: () => true,
    maxRedirects: redirect === 'follow' ? undefined : 0,
  });
}
