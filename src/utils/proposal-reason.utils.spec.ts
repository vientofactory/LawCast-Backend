import {
  canonicalizeProposalReason,
  canonicalizeProposalReasonForComparison,
} from './proposal-reason.utils';

describe('canonicalizeProposalReason', () => {
  it('preserves paragraph breaks while normalizing line endings and spaces', () => {
    expect(
      canonicalizeProposalReason('  첫 줄  \r\n 둘째   줄 \r\n\r\n  넷째 줄  '),
    ).toBe('첫 줄\n둘째 줄\n\n넷째 줄');
  });

  it('returns null for absent or whitespace-only text', () => {
    expect(canonicalizeProposalReason(null)).toBeNull();
    expect(canonicalizeProposalReason(undefined)).toBeNull();
    expect(canonicalizeProposalReason(' \t\r\n ')).toBeNull();
  });

  it('normalizes unicode whitespace without discarding line breaks', () => {
    expect(canonicalizeProposalReason('첫\u00a0줄\u200b\n둘째\u2028줄')).toBe(
      '첫 줄\n둘째\n줄',
    );
  });

  it('uses a line-layout-insensitive comparison key', () => {
    expect(
      canonicalizeProposalReasonForComparison('첫 줄\n둘째 줄\n\n셋째 줄'),
    ).toBe('첫 줄 둘째 줄 셋째 줄');
    expect(
      canonicalizeProposalReasonForComparison('첫 줄 둘째 줄 셋째 줄'),
    ).toBe('첫 줄 둘째 줄 셋째 줄');
  });
});
