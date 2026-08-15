import { canonicalizeProposalReason } from './proposal-reason.utils';

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
});
