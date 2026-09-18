/**
 * Categorises screenshot capture errors into user-friendly reason codes so
 * that the UI can display actionable messages instead of raw error strings.
 */

export enum ScreenshotFailureReason {
  /** JPEG buffer exceeds the 500 KiB storage limit after all recompression strategies. */
  SIZE_LIMIT = 'size_limit',
  /** Network-level failure (DNS, TCP, TLS, HTTP timeout/reset). */
  NETWORK_ERROR = 'network_error',
  /** Headless browser failure (launch, crash, navigation, page gone). */
  BROWSER_ERROR = 'browser_error',
  /**国会 Waitingroom / rate-limit anti-bot page could not be bypassed. */
  RATE_LIMITED = 'rate_limited',
  /** Puppeteer page.screenshot() call itself threw. */
  SCREENSHOT_FAILED = 'screenshot_failed',
  /** Classification not possible — falls back to raw error passthrough. */
  UNKNOWN = 'unknown',
}

/**
 * Korean, user-facing one-liners shown in the notice detail page.
 * Keys mirror `ScreenshotFailureReason`.
 */
export const SCREENSHOT_FAILURE_MESSAGES: Record<
  ScreenshotFailureReason,
  string
> = {
  [ScreenshotFailureReason.SIZE_LIMIT]:
    '페이지 내용이 너무 커서 스크린샷을 저장할 수 없습니다',
  [ScreenshotFailureReason.NETWORK_ERROR]:
    '네트워크 연결 문제로 스크린샷을 캡처하지 못했습니다',
  [ScreenshotFailureReason.BROWSER_ERROR]:
    '브라우저 오류로 스크린샷을 캡처하지 못했습니다',
  [ScreenshotFailureReason.RATE_LIMITED]:
    '국회 웹사이트 접근 제한으로 스크린샷을 캡처하지 못했습니다',
  [ScreenshotFailureReason.SCREENSHOT_FAILED]:
    '스크린샷 캡처 중 오류가 발생했습니다',
  [ScreenshotFailureReason.UNKNOWN]:
    '스크린샷 캡처 중 알 수 없는 오류가 발생했습니다',
};

const NETWORK_ERROR_PATTERNS = [
  'econnreset',
  'econnrefused',
  'etimedout',
  'enotfound',
  'enotconnected',
  'epipe',
  'eai_again',
  'socket hang up',
  'network',
  'fetch failed',
  'request timeout',
  'read econnreset',
  'tls',
  'certificate',
  'ssl',
];

const BROWSER_ERROR_PATTERNS = [
  'browser closed',
  'browser was disconnected',
  'page crashed',
  'target closed',
  'target crashed',
  'session closed',
  'session detached',
  'navigation failed',
  'net::err_',
  'failed to launch',
  'no available',
  'maxListeners',
  'protocol error',
  'timeout',
  'destroy',
  'leak-test',
  'zombie-test',
  'sole-lease',
];

const RATE_LIMIT_PATTERNS = [
  'waitingroom',
  'waiting room',
  '307 temporary',
  'rate limit',
  'too many requests',
  '429',
  'アクセスが集中',
];

/**
 * Best-effort classification of an error into a `ScreenshotFailureReason`.
 *
 * The classifier inspects `error.message` and `error.name` using simple
 * substring matching — it is deliberately lenient (prefers UNKNOWN over a
 * wrong classification) because the raw error string is always stored
 * alongside the reason code for debugging.
 */
export function classifyScreenshotError(
  error: unknown,
): ScreenshotFailureReason {
  if (!(error instanceof Error)) return ScreenshotFailureReason.UNKNOWN;

  const haystack = `${error.name} ${error.message}`.toLowerCase();

  for (const pattern of RATE_LIMIT_PATTERNS) {
    if (haystack.includes(pattern)) return ScreenshotFailureReason.RATE_LIMITED;
  }

  for (const pattern of NETWORK_ERROR_PATTERNS) {
    if (haystack.includes(pattern))
      return ScreenshotFailureReason.NETWORK_ERROR;
  }

  for (const pattern of BROWSER_ERROR_PATTERNS) {
    if (haystack.includes(pattern))
      return ScreenshotFailureReason.BROWSER_ERROR;
  }

  if (haystack.includes('screenshot')) {
    return ScreenshotFailureReason.SCREENSHOT_FAILED;
  }

  return ScreenshotFailureReason.UNKNOWN;
}

/**
 * Builds the string stored in `notice_archives.screenshot_capture_error`.
 *
 * Format: `"${userMessage} (${reason})"` — the parenthetical reason code is
 * appended so support tooling can filter/group by it while the leading part
 * remains human-readable.
 */
export function formatScreenshotCaptureError(
  reason: ScreenshotFailureReason,
  rawError?: string,
): string {
  const base = SCREENSHOT_FAILURE_MESSAGES[reason];
  if (reason === ScreenshotFailureReason.UNKNOWN && rawError) {
    return rawError;
  }
  return rawError ? `${base} (${reason}: ${rawError})` : `${base} (${reason})`;
}
