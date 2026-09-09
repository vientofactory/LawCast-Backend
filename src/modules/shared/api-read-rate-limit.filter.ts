import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { ApiReadRateLimitException } from './api-read-rate-limit.service';

@Catch(ApiReadRateLimitException)
export class ApiReadRateLimitFilter implements ExceptionFilter<ApiReadRateLimitException> {
  catch(exception: ApiReadRateLimitException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    response.setHeader('Retry-After', exception.retryAfterSeconds.toString());
    response.status(exception.getStatus()).json(exception.getResponse());
  }
}
