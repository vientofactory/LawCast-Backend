import type { Request } from 'express';
import {
  DiscussionRateLimitException,
  DiscussionsRateLimitService,
} from './discussions-rate-limit.service';

function createRequest(ip: string): Request {
  return {
    headers: { 'x-forwarded-for': ip },
  } as unknown as Request;
}

describe('DiscussionsRateLimitService', () => {
  it('allows requests within the bucket policy and stores an IP-hashed key', async () => {
    const cacheService = {
      getNumber: jest.fn().mockResolvedValue(null),
      setNumber: jest.fn().mockResolvedValue(undefined),
    };
    const service = new DiscussionsRateLimitService(cacheService as never);

    await service.assertAllowed(createRequest('123.45.67.89'), 'write');

    expect(cacheService.setNumber).toHaveBeenCalledWith(
      expect.stringMatching(/^discussion_rate_limit:v1:write:[a-f0-9]{64}$/),
      1,
      60_000,
    );
  });

  it('rejects requests after the bucket limit is reached', async () => {
    const cacheService = {
      getNumber: jest.fn().mockResolvedValue(10),
      setNumber: jest.fn(),
    };
    const service = new DiscussionsRateLimitService(cacheService as never);

    await expect(
      service.assertAllowed(createRequest('123.45.67.89'), 'write'),
    ).rejects.toBeInstanceOf(DiscussionRateLimitException);
    await expect(
      service.assertAllowed(createRequest('123.45.67.89'), 'write'),
    ).rejects.toMatchObject({
      retryAfterSeconds: 60,
      response: {
        statusCode: 429,
        retryAfter: 60,
      },
    });
    expect(cacheService.setNumber).not.toHaveBeenCalled();
  });

  it('uses a separate read bucket policy', async () => {
    const cacheService = {
      getNumber: jest.fn().mockResolvedValue(59),
      setNumber: jest.fn().mockResolvedValue(undefined),
    };
    const service = new DiscussionsRateLimitService(cacheService as never);

    await service.assertAllowed(createRequest('123.45.67.89'), 'read');

    expect(cacheService.setNumber).toHaveBeenCalledWith(
      expect.stringMatching(/^discussion_rate_limit:v1:read:[a-f0-9]{64}$/),
      60,
      60_000,
    );
  });
});
