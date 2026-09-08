import { ApiReadRateLimitService } from './api-read-rate-limit.service';

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
});
