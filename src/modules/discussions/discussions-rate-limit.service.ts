import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { CacheService } from '../cache/cache.service';
import { IpMaskingUtil } from './utils/ip-masking.util';

export type DiscussionRateLimitBucket = 'read' | 'write';

interface RateLimitPolicy {
  maxRequests: number;
  windowSeconds: number;
}

export class DiscussionRateLimitException extends HttpException {
  constructor(readonly retryAfterSeconds: number) {
    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.',
        retryAfter: retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

@Injectable()
export class DiscussionsRateLimitService {
  private readonly policies: Record<
    DiscussionRateLimitBucket,
    RateLimitPolicy
  > = {
    // Browsing is intentionally more permissive than mutations.
    read: { maxRequests: 60, windowSeconds: 60 },
    write: { maxRequests: 10, windowSeconds: 60 },
  };

  constructor(private readonly cacheService: CacheService) {}

  async assertAllowed(
    request: Request,
    bucket: DiscussionRateLimitBucket,
  ): Promise<void> {
    const policy = this.policies[bucket];
    const clientIp = IpMaskingUtil.extractClientIp(request);
    const ipHash = IpMaskingUtil.hashIp(clientIp);
    const key = `discussion_rate_limit:v1:${bucket}:${ipHash}`;
    const currentCount = (await this.cacheService.getNumber(key)) ?? 0;

    if (currentCount >= policy.maxRequests) {
      throw new DiscussionRateLimitException(policy.windowSeconds);
    }

    await this.cacheService.setNumber(
      key,
      currentCount + 1,
      policy.windowSeconds * 1000,
    );
  }
}
