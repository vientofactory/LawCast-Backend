import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { LoggerUtils } from '../utils/logger.utils';

@Injectable()
export class RecaptchaService {
  private readonly logger = new Logger(RecaptchaService.name);
  private readonly verifyUrl =
    'https://www.google.com/recaptcha/api/siteverify';

  constructor(private readonly configService: ConfigService) {}

  async verifyToken(token: string, remoteIp?: string): Promise<boolean> {
    const secretKey = this.configService.get<string>('recaptcha.secretKey');

    // If no secret key is configured, skip verification
    if (!secretKey) {
      this.logger.warn('reCAPTCHA secret key not configured');
      return true;
    }

    if (!token) {
      this.logger.warn('reCAPTCHA token is missing');
      return false;
    }

    try {
      const response = await axios.post(this.verifyUrl, null, {
        params: {
          secret: secretKey,
          response: token,
          ...(remoteIp && { remoteip: remoteIp }),
        },
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      const { success, score, action } = response.data;

      LoggerUtils.debugDev(
        RecaptchaService.name,
        `reCAPTCHA verification result:`,
        {
          success,
          score,
          action,
        },
      );

      return success;
    } catch (error) {
      this.logger.error('reCAPTCHA verification failed:', error);
      // 예외 발생 시 거부 우선(default deny)
      return false;
    }
  }
}
