import {
  ApiReadRateLimitException,
  ApiReadRateLimitService,
} from './api-read-rate-limit.service';
import { IpMaskingUtil } from '../discussions/utils/ip-masking.util';

/**
 * The service keys rate-limit buckets on the original visitor IP (via
 * IpMaskingUtil). These tests pin the header priority that keeps SSR traffic
 * from collapsing into a single shared bucket keyed on the edge IP.
 */
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

  it('keys the bucket on the SSR-forwarded x-lawcast-client-ip, not the peer IP', async () => {
    const cacheService = {
      getNumber: jest.fn().mockResolvedValue(0),
      setNumber: jest.fn(),
    };
    const service = new ApiReadRateLimitService(cacheService as any);

    // SSR hop: the socket peer is the frontend worker/edge, the real user is
    // identified by the forwarded header.
    await service.assertAllowed({
      ip: '10.0.0.1',
      headers: { 'x-lawcast-client-ip': '203.0.113.7' },
      socket: { remoteAddress: '10.0.0.1' },
    } as any);

    const cacheKey = cacheService.setNumber.mock.calls[0][0] as string;
    expect(cacheKey).toContain(IpMaskingUtil.hashIp('203.0.113.7'));
    expect(cacheKey).not.toContain(IpMaskingUtil.hashIp('10.0.0.1'));
  });

  it('gives different users different buckets', async () => {
    const cacheService = {
      getNumber: jest.fn().mockResolvedValue(0),
      setNumber: jest.fn(),
    };
    const service = new ApiReadRateLimitService(cacheService as any);

    await service.assertAllowed({
      ip: '10.0.0.1',
      headers: { 'x-lawcast-client-ip': '203.0.113.7' },
    } as any);
    await service.assertAllowed({
      ip: '10.0.0.1',
      headers: { 'x-lawcast-client-ip': '198.51.100.9' },
    } as any);

    const [firstKey] = cacheService.setNumber.mock.calls[0] as [string];
    const [secondKey] = cacheService.setNumber.mock.calls[1] as [string];
    expect(firstKey).not.toBe(secondKey);
  });

  it('falls back to cf-connecting-ip when no forwarded header is present', async () => {
    const cacheService = {
      getNumber: jest.fn().mockResolvedValue(0),
      setNumber: jest.fn(),
    };
    const service = new ApiReadRateLimitService(cacheService as any);

    await service.assertAllowed({
      ip: '10.0.0.1',
      headers: { 'cf-connecting-ip': '203.0.113.42' },
    } as any);

    const [cacheKey] = cacheService.setNumber.mock.calls[0] as [string];
    expect(cacheKey).toContain(IpMaskingUtil.hashIp('203.0.113.42'));
  });

  it('does not let an array-valued forwarded header crash extraction', async () => {
    const cacheService = {
      getNumber: jest.fn().mockResolvedValue(0),
      setNumber: jest.fn(),
    };
    const service = new ApiReadRateLimitService(cacheService as any);

    await expect(
      service.assertAllowed({
        ip: '10.0.0.1',
        headers: { 'x-lawcast-client-ip': ['203.0.113.7'] },
        socket: { remoteAddress: '10.0.0.1' },
      } as any),
    ).resolves.toBeUndefined();

    const [cacheKey] = cacheService.setNumber.mock.calls[0] as [string];
    expect(cacheKey).toContain(IpMaskingUtil.hashIp('203.0.113.7'));
  });
});
