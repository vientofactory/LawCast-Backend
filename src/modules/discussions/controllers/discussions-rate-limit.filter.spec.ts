import type { ArgumentsHost } from '@nestjs/common';
import { DiscussionRateLimitException } from '../discussions-rate-limit.service';
import { DiscussionsRateLimitFilter } from './discussions-rate-limit.filter';

describe('DiscussionsRateLimitFilter', () => {
  it('sets Retry-After and returns the structured 429 response', () => {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const setHeader = jest.fn();
    const response = { setHeader, status };
    const host = {
      switchToHttp: () => ({ getResponse: () => response }),
    } as unknown as ArgumentsHost;
    const exception = new DiscussionRateLimitException(60);

    new DiscussionsRateLimitFilter().catch(exception, host);

    expect(setHeader).toHaveBeenCalledWith('Retry-After', '60');
    expect(status).toHaveBeenCalledWith(429);
    expect(json).toHaveBeenCalledWith({
      statusCode: 429,
      message: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.',
      retryAfter: 60,
    });
  });
});
