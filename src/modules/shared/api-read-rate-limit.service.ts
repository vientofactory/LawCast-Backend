import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { CacheService } from '../cache/cache.service';

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

  constructor(private readonly cacheService: CacheService) {}

  async assertAllowed(
    request: Request,
    bucket: ApiReadRateLimitBucket = 'standard',
  ): Promise<void> {
    const policy = this.policies[bucket];
    const rawIp = String(
      request.ip ??
        request.headers['x-forwarded-for'] ??
        request.socket.remoteAddress ??
        'unknown',
    );
    const clientKey = createHash('sha256').update(rawIp).digest('hex');
    const cacheKey = `api_read_rate_limit:v1:${bucket}:${clientKey}`;
    const currentCount = (await this.cacheService.getNumber(cacheKey)) ?? 0;

    if (currentCount >= policy.maxRequests) {
      throw new HttpException(
        'Too many requests. Please retry shortly.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    await this.cacheService.setNumber(
      cacheKey,
      currentCount + 1,
      policy.windowSeconds * 1_000,
    );
  }
}
