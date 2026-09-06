import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { DiscussionRateLimitException } from '../discussions-rate-limit.service';

@Catch(DiscussionRateLimitException)
export class DiscussionsRateLimitFilter implements ExceptionFilter<DiscussionRateLimitException> {
  catch(exception: DiscussionRateLimitException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    response.setHeader('Retry-After', exception.retryAfterSeconds.toString());
    response.status(exception.getStatus()).json(exception.getResponse());
  }
}
