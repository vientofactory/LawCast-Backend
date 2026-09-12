import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { CacheService } from '../cache/cache.service';
import { IpMaskingUtil } from './utils/ip-masking.util';

export type DiscussionRateLimitBucket = 'read' | 'write';
export type DiscussionReadRateLimitScope =
  'notice-threads' | 'all-threads' | 'thread-detail';

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
    // Separate read scopes prevent normal list/detail navigation from sharing
    // a small bucket while retaining a per-endpoint abuse boundary.
    read: { maxRequests: 300, windowSeconds: 60 },
    write: { maxRequests: 10, windowSeconds: 60 },
  };

  constructor(private readonly cacheService: CacheService) {}

  async assertAllowed(
    request: Request,
    bucket: DiscussionRateLimitBucket,
    scope?: DiscussionReadRateLimitScope,
  ): Promise<void> {
    const policy = this.policies[bucket];
    // Reject unattributable requests instead of collapsing them into one
    // placeholder-IP bucket shared by every such client.
    const clientIp = IpMaskingUtil.requireClientIp(request);
    const ipHash = IpMaskingUtil.hashIp(clientIp);
    const scopeKey = bucket === 'read' ? (scope ?? 'default') : 'default';
    const key = `discussion_rate_limit:v2:${bucket}:${scopeKey}:${ipHash}`;
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
