/**
 * Detects the NSM portal's own error page.
 *
 * `opinion.lawmaking.go.kr` answers requests it refuses to serve (blacklisted
 * User-Agent, removed path, session/anti-bot rejection) with HTTP 200 and a
 * small shell page whose body carries the `errorWrap` class and the text
 * `요청페이지가 없습니다`. That response contains no notice data at all, so it
 * must never be read as "the bill is still there": deletion probes and list
 * scans both need to tell it apart from a real page. Without this check a
 * blocked probe looks exactly like a live bill, which hides the block.
 */
export function isNsmPortalErrorPageHtml(
  html: string | null | undefined,
): boolean {
  if (!html) {
    return false;
  }

  const compact = html.replace(/\s+/g, ' ');

  if (/class\s*=\s*["'][^"']*\berrorWrap\b[^"']*["']/i.test(compact)) {
    return true;
  }

  return compact.includes('요청페이지가 없습니다');
}
