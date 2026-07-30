import { describe, expect, it } from '@jest/globals';
import {
  isIncompleteCompetentAuthorityName,
  recoverCompetentAuthorityName,
} from './competent-authority-autocomplete.utils';

describe('competent-authority-autocomplete utils', () => {
  it('recovers common committee aliases', () => {
    expect(recoverCompetentAuthorityName('법사위')).toBe('법제사법위원회');
    expect(recoverCompetentAuthorityName('정무위')).toBe('정무위원회');
  });

  it('recovers truncated ministry names when ministry preference is provided', () => {
    expect(
      recoverCompetentAuthorityName('과학기술정보통신', {
        preferredKinds: ['ministry', 'agency', 'committee'],
      }),
    ).toBe('과학기술정보통신부');
  });

  it('recovers truncated committee names with committee preference', () => {
    expect(
      recoverCompetentAuthorityName('국토교통', {
        preferredKinds: ['committee', 'ministry', 'agency'],
      }),
    ).toBe('국토교통위원회');
  });

  it('keeps already complete names unchanged', () => {
    expect(recoverCompetentAuthorityName('교육부')).toBe('교육부');
    expect(recoverCompetentAuthorityName('행정안전위원회')).toBe(
      '행정안전위원회',
    );
  });

  it('detects likely incomplete authority names using suffix rules', () => {
    expect(isIncompleteCompetentAuthorityName('국토교통')).toBe(true);
    expect(isIncompleteCompetentAuthorityName('국토교통위원회')).toBe(false);
    expect(isIncompleteCompetentAuthorityName('행정안전부')).toBe(false);
  });
});
