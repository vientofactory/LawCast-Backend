import { BadRequestException } from '@nestjs/common';
import { APP_CONSTANTS } from '../config/app.config';

export const API_REQUEST_LIMITS = {
  MAX_PAGE: 10_000,
  MAX_NOTICE_NUMS: 100,
  MAX_NOTICE_NUMS_QUERY_LENGTH: 1_500,
} as const;

export function assertValidPage(page: number): void {
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > API_REQUEST_LIMITS.MAX_PAGE
  ) {
    throw new BadRequestException(
      `page must be between 1 and ${API_REQUEST_LIMITS.MAX_PAGE}.`,
    );
  }
}

export function assertSearchLength(value?: string): void {
  if ((value?.trim().length ?? 0) > APP_CONSTANTS.API.SEARCH.MAX_LENGTH) {
    throw new BadRequestException(
      `search must not exceed ${APP_CONSTANTS.API.SEARCH.MAX_LENGTH} characters.`,
    );
  }
}

export function assertNoticeNumsInput(value?: string): void {
  if ((value?.length ?? 0) > API_REQUEST_LIMITS.MAX_NOTICE_NUMS_QUERY_LENGTH) {
    throw new BadRequestException(
      `noticeNums must not exceed ${API_REQUEST_LIMITS.MAX_NOTICE_NUMS} values.`,
    );
  }
}

export function assertValidStatisticsDateRange(
  startDate?: string,
  endDate?: string,
): void {
  const values = [startDate, endDate].filter((value): value is string =>
    Boolean(value?.trim()),
  );
  for (const value of values) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    const year = Number(match?.[1]);
    const month = Number(match?.[2]);
    const day = Number(match?.[3]);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (
      !match ||
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() !== month - 1 ||
      parsed.getUTCDate() !== day
    ) {
      throw new BadRequestException('Dates must use YYYY-MM-DD format.');
    }
  }

  if (startDate && endDate && startDate > endDate) {
    throw new BadRequestException('startDate must not be after endDate.');
  }
}
