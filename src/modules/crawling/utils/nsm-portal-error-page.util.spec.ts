import { describe, expect, it } from '@jest/globals';
import { isNsmPortalErrorPageHtml } from './nsm-portal-error-page.util';

describe('isNsmPortalErrorPageHtml', () => {
  it('detects the portal error shell by its errorWrap body class', () => {
    const html = `
      <!DOCTYPE html>
      <html lang="ko"><head><title>국민참여입법센터</title></head>
      <body class="errorWrap">
        <section class="errorPanel">
          <button onclick="location.href='/'">메인화면으로 이동</button>
          <button onclick="history.back()">이전화면으로 이동</button>
        </section>
      </body></html>
    `;

    expect(isNsmPortalErrorPageHtml(html)).toBe(true);
  });

  it('detects the shell by its missing-page text alone', () => {
    expect(
      isNsmPortalErrorPageHtml(
        '<html><body><p>404 (페이지 없음) Not Found</p><p>요청페이지가 없습니다.</p></body></html>',
      ),
    ).toBe(true);
  });

  it('does not flag a real detail page', () => {
    const html = `
      <html><head><title>법률안 상세</title></head>
      <body>
        <div id="containerWrap">
          <p class="subjectHead_tit">학교체육 진흥법 일부개정법률안</p>
          <table class="gridCnt_table"><tbody><tr><td>제안이유</td></tr></tbody></table>
          <form name="VIEW_FM"></form>
        </div>
      </body></html>
    `;

    expect(isNsmPortalErrorPageHtml(html)).toBe(false);
  });

  it('returns false for empty or missing input', () => {
    expect(isNsmPortalErrorPageHtml('')).toBe(false);
    expect(isNsmPortalErrorPageHtml(null)).toBe(false);
    expect(isNsmPortalErrorPageHtml(undefined)).toBe(false);
  });
});
