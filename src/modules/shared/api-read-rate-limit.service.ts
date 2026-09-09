import { HttpException, HttpStatus, Injectable, type LoggerService } from '@nestjs/common';
import type { Request } from 'express';
import { CacheService } from '../cache/cache.service';
import { IpMaskingUtil } from '../discussions/utils/ip-masking.util';

type ApiReadRateLimitBucket = 'standard' | 'expensive';

@Injectable()
export class ApiReadRateLimitService {
  private readonly policies: Record<
    ApiReadRateLimitBucket,
    { maxRequests: number; windowSeconds: number }
  > = {
    standard: { maxRequests: 60, windowSeconds: 60 },
    expensive: { maxRequests: 30, windowSeconds: 60 },
  };

  constructor(
    private readonly cacheService: CacheService,
    private readonly logger?: LoggerService,
  ) {}

  /**
   * True when the request carries no forwarded client identity at all, i.e.
   * the rate-limit bucket would key on the immediate peer address. For SSR
   * traffic that peer is the frontend worker/edge, so a persistent spike of
   * these warnings means client-IP forwarding broke upstream.
   */
  static hasNoForwardedIdentity(request: Request): boolean {
    const headers = request.headers ?? {};
    return !(
      headers['x-lawcast-client-ip'] ||
      headers['cf-connecting-ip'] ||
      headers['true-client-ip'] ||
      headers['x-forwarded-for'] ||
      headers['x-real-ip']
    );
  }

  async assertAllowed(
    request: Request,
    bucket: ApiReadRateLimitBucket = 'standard',
  ): Promise<void> {
    const policy = this.policies[bucket];

    // Key on the original visitor IP, not the immediate peer. SSR traffic
    // arrives from the frontend worker/proxy, so the peer address would put
    // every user in one shared bucket. Header priority (x-lawcast-client-ip
    // first) matches DiscussionsRateLimitService via IpMaskingUtil.
    const clientIp = IpMaskingUtil.extractClientIp(request);
    const clientKey = IpMaskingUtil.hashIp(clientIp);

    if (ApiReadRateLimitService.hasNoForwardedIdentity(request)) {
      this.logger?.warn?.(
        `api-read-rate-limit keyed on peer address (no forwarded client IP header); peer=${request.ip ?? request.socket?.remoteAddress ?? 'unknown'}`,
      );
    }
    const cacheKey = `api_read_rate_limit:v1:${bucket}:${clientKey}`;
    const currentCount = (await this.cacheService.getNumber(cacheKey)) ?? 0;

    if (currentCount >= policy.maxRequests) {
      throw new ApiReadRateLimitException(policy.windowSeconds);
    }

    await this.cacheService.setNumber(
      cacheKey,
      currentCount + 1,
      policy.windowSeconds * 1_000,
    );
  }
}

/**
 * 429 with a structured body the frontend can act on:
 * `{ statusCode, message, retryAfter }` plus a `Retry-After` header.
 */
export class ApiReadRateLimitException extends HttpException {
  constructor(readonly retryAfterSeconds: number) {
    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: 'Too many requests. Please retry shortly.',
        retryAfter: retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
