import { BadRequestException, ValidationPipeOptions } from '@nestjs/common';
import { APP_CONSTANTS } from '../config/app.config';

export class WebhookValidationUtils {
  static validateDiscordWebhookUrl(url: string): void {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new BadRequestException({
        success: false,
        message: '올바르지 않은 URL 형식입니다.',
      });
    }

    // Validate Discord domain
    this.validateDiscordDomain(parsedUrl.hostname);

    // Validate webhook path
    this.validateWebhookPath(parsedUrl.pathname);

    // Validate webhook ID and token
    this.validateWebhookIdAndToken(parsedUrl.pathname);
  }

  private static validateDiscordDomain(hostname: string): void {
    if (hostname !== 'discord.com' && hostname !== 'discordapp.com') {
      throw new BadRequestException({
        success: false,
        message: 'Discord 웹훅 URL만 지원됩니다.',
      });
    }
  }

  private static validateWebhookPath(pathname: string): void {
    if (!pathname.startsWith('/api/webhooks/')) {
      throw new BadRequestException({
        success: false,
        message: '올바른 Discord 웹훅 URL 형식이 아닙니다.',
      });
    }
  }

  private static validateWebhookIdAndToken(pathname: string): void {
    const pathParts = pathname.split('/');

    if (
      pathParts.length < APP_CONSTANTS.DISCORD.WEBHOOK.PATH_PARTS_MIN ||
      !pathParts[3] ||
      !pathParts[4]
    ) {
      throw new BadRequestException({
        success: false,
        message: '웹훅 URL에 필요한 정보가 누락되었습니다.',
      });
    }

    const webhookId = pathParts[3];
    const webhookToken = pathParts[4];

    if (
      !this.isValidSnowflakeId(webhookId) ||
      !this.isValidWebhookToken(webhookToken)
    ) {
      throw new BadRequestException({
        success: false,
        message: '올바르지 않은 웹훅 토큰 형식입니다.',
      });
    }
  }

  private static isValidSnowflakeId(id: string): boolean {
    const { MIN, MAX } = APP_CONSTANTS.DISCORD.WEBHOOK.SNOWFLAKE_ID_LENGTH;
    const regex = new RegExp(`^\\d{${MIN},${MAX}}$`);
    return regex.test(id);
  }

  private static isValidWebhookToken(token: string): boolean {
    const { MIN, MAX } = APP_CONSTANTS.DISCORD.WEBHOOK.TOKEN_LENGTH;
    const regex = new RegExp(`^[a-zA-Z0-9_-]{${MIN},${MAX}}$`);
    return regex.test(token);
  }

  static extractClientIp(req: any): string {
    return (
      req.ip ||
      req.connection?.remoteAddress ||
      req.headers['x-forwarded-for'] ||
      'unknown'
    );
  }

  static getValidationPipeOptions(): ValidationPipeOptions {
    return {
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (errors: any[]) => {
        const messages: string[] = errors
          .map((error) => Object.values(error.constraints || {}).join(', '))
          .flatMap((msg) =>
            msg
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          );
        return new BadRequestException({
          success: false,
          message: 'Validation failed',
          errors: messages,
        });
      },
    };
  }
}
