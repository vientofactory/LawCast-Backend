import {
  ApiReadRateLimitException,
  ApiReadRateLimitService,
} from './api-read-rate-limit.service';

describe('ApiReadRateLimitService', () => {
  it('rejects a request after its bucket limit is reached', async () => {
    const cacheService = {
      getNumber: jest.fn().mockResolvedValue(30),
      setNumber: jest.fn(),
    };
    const service = new ApiReadRateLimitService(cacheService as any);

    await expect(
      service.assertAllowed(
        { ip: '127.0.0.1', headers: {}, socket: {} } as any,
        'expensive',
      ),
    ).rejects.toMatchObject({ status: 429 });
    expect(cacheService.setNumber).not.toHaveBeenCalled();
  });

  it('exposes retryAfter on the thrown exception for countdown UIs', async () => {
    const cacheService = {
      getNumber: jest.fn().mockResolvedValue(60),
      setNumber: jest.fn(),
    };
    const service = new ApiReadRateLimitService(cacheService as any);

    const rejection = service
      .assertAllowed({ ip: '127.0.0.1', headers: {}, socket: {} } as any)
      .catch((err) => err);

    const err: ApiReadRateLimitException = await rejection;
    expect(err).toBeInstanceOf(ApiReadRateLimitException);
    expect(err.retryAfterSeconds).toBe(60);
    expect(err.getResponse()).toMatchObject({
      statusCode: 429,
      message: 'Too many requests. Please retry shortly.',
      retryAfter: 60,
    });
  });
});
