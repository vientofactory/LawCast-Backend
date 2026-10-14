import { afterEach, describe, expect, it } from '@jest/globals';
import { Config, LikmsNsmAdapter, type ILikmsStateBillItem } from 'pal-crawl';
import { CrawlingCoreService } from '../crawling-core.service';
import { isNsmPendingStreamRedundant } from '../../../utils/crawler-activation.utils';

/**
 * The LIKMS pending stream is skipped (see `isNsmPendingStreamRedundant`)
 * because the adapter derives that stream by filtering the very same list the
 * all-bills scan already walked, using
 * `Config.LIKMS_PENDING_PROGRESS_STATUS`. These tests pin both halves of that
 * assumption against the real pal-crawl package, so a vocabulary change there
 * fails here instead of silently dropping pending bills from classification.
 */
describe('LIKMS pending-stream skip contract', () => {
  afterEach(() => {
    delete process.env.CRAWLING_NSM_SOURCE;
  });

  const makeItem = (
    billNo: string,
    progressStatus: string,
  ): ILikmsStateBillItem => ({
    billNo,
    billId: `PRC_${billNo}`,
    billName: '계류 법안',
    proposer: '홍길동의원',
    proposerKind: '의원',
    proposalDate: '2026-10-13',
    committee: '',
    progressStatus,
    hasProposalReason: true,
    proposalReason: null,
    link: `https://likms.assembly.go.kr/bill/${billNo}`,
  });

  it("treats pal-crawl's own LIKMS pending status as pending-like", () => {
    expect(
      CrawlingCoreService.isPendingProgressStatus(
        Config.LIKMS_PENDING_PROGRESS_STATUS,
      ),
    ).toBe(true);
  });

  it('classifies LIKMS items exactly like the adapter pending filter', () => {
    const items = [
      makeItem('2221883', Config.LIKMS_PENDING_PROGRESS_STATUS),
      makeItem('2221882', '소관위접수'),
      makeItem('2221881', '소관위심사'),
    ];

    const adapterPending = new LikmsNsmAdapter().likms
      .filterPending(items)
      .map((item) => item.billNo);

    expect(adapterPending).toEqual(['2221883']);
    expect(
      items
        .filter((item) =>
          CrawlingCoreService.isPendingProgressStatus(item.progressStatus),
        )
        .map((item) => item.billNo),
    ).toEqual(adapterPending);
  });

  it('keeps the pending stream for the NSM portal and skips it for LIKMS', () => {
    expect(isNsmPendingStreamRedundant()).toBe(false);

    process.env.CRAWLING_NSM_SOURCE = 'likms';
    expect(isNsmPendingStreamRedundant()).toBe(true);
  });
});
