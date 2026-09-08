import { BadRequestException } from '@nestjs/common';
import {
  API_REQUEST_LIMITS,
  assertNoticeNumsInput,
  assertSearchLength,
  assertValidPage,
  assertValidStatisticsDateRange,
} from './request-limits.utils';

describe('request limits', () => {
  it('rejects pages outside the supported range', () => {
    expect(() => assertValidPage(1)).not.toThrow();
    expect(() => assertValidPage(API_REQUEST_LIMITS.MAX_PAGE + 1)).toThrow(
      BadRequestException,
    );
  });

  it('rejects oversized search and notice number inputs', () => {
    expect(() => assertSearchLength('a'.repeat(121))).toThrow(
      BadRequestException,
    );
    expect(() =>
      assertNoticeNumsInput(
        '1'.repeat(API_REQUEST_LIMITS.MAX_NOTICE_NUMS_QUERY_LENGTH + 1),
      ),
    ).toThrow(BadRequestException);
  });

  it('rejects invalid or reversed statistics date ranges', () => {
    expect(() => assertValidStatisticsDateRange('2026-02-30')).toThrow(
      BadRequestException,
    );
    expect(() =>
      assertValidStatisticsDateRange('2026-09-02', '2026-09-01'),
    ).toThrow(BadRequestException);
  });
});
