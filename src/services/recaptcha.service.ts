import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class RecaptchaService {
  private readonly logger = new Logger(RecaptchaService.name);
  private readonly secretKey = process.env.RECAPTCHA_SECRET_KEY;
  private readonly verifyUrl =
    'https://www.google.com/recaptcha/api/siteverify';

  async verifyToken(token: string, remoteIp?: string): Promise<boolean> {
    if (!this.secretKey) {
      this.logger.warn('reCAPTCHA secret key not configured');
      return true; // 개발 환경에서는 통과
    }

    if (!token) {
      this.logger.warn('reCAPTCHA token is missing');
      return false;
    }

    try {
      const response = await axios.post(this.verifyUrl, null, {
        params: {
          secret: this.secretKey,
          response: token,
          ...(remoteIp && { remoteip: remoteIp }),
        },
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      const { success, score, action } = response.data;

      this.logger.debug(`reCAPTCHA verification result:`, {
        success,
        score,
        action,
      });

      return success;
    } catch (error) {
      this.logger.error('reCAPTCHA verification failed:', error);
      return false;
    }
  }
}
