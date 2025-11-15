import { BadRequestException, ValidationPipeOptions } from '@nestjs/common';
import { APP_CONSTANTS } from '../config/app.config';

export class WebhookValidationUtils {
  /**
   * Discord 웹훅 URL의 유효성을 검증합니다.
   */
  static validateDiscordWebhookUrl(url: string): void {
    // URL 파싱 검증
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new BadRequestException({
        success: false,
        message: '올바르지 않은 URL 형식입니다.',
      });
    }

    // Discord 도메인 검증
    this.validateDiscordDomain(parsedUrl.hostname);

    // 웹훅 경로 검증
    this.validateWebhookPath(parsedUrl.pathname);

    // 웹훅 ID와 토큰 검증
    this.validateWebhookIdAndToken(parsedUrl.pathname);
  }

  /**
   * Discord 도메인을 검증합니다.
   */
  private static validateDiscordDomain(hostname: string): void {
    if (hostname !== 'discord.com' && hostname !== 'discordapp.com') {
      throw new BadRequestException({
        success: false,
        message: 'Discord 웹훅 URL만 지원됩니다.',
      });
    }
  }

  /**
   * 웹훅 경로를 검증합니다.
   */
  private static validateWebhookPath(pathname: string): void {
    if (!pathname.startsWith('/api/webhooks/')) {
      throw new BadRequestException({
        success: false,
        message: '올바른 Discord 웹훅 URL 형식이 아닙니다.',
      });
    }
  }

  /**
   * 웹훅 ID와 토큰을 검증합니다.
   */
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

    // 웹훅 ID 형식 검증 (Discord Snowflake ID)
    if (!this.isValidSnowflakeId(webhookId)) {
      throw new BadRequestException({
        success: false,
        message: '올바르지 않은 웹훅 ID 형식입니다.',
      });
    }

    // 웹훅 토큰 형식 검증
    if (!this.isValidWebhookToken(webhookToken)) {
      throw new BadRequestException({
        success: false,
        message: '올바르지 않은 웹훅 토큰 형식입니다.',
      });
    }
  }

  /**
   * Discord Snowflake ID 형식을 검증합니다.
   */
  private static isValidSnowflakeId(id: string): boolean {
    const { MIN, MAX } = APP_CONSTANTS.DISCORD.WEBHOOK.SNOWFLAKE_ID_LENGTH;
    const regex = new RegExp(`^\\d{${MIN},${MAX}}$`);
    return regex.test(id);
  }

  /**
   * Discord 웹훅 토큰 형식을 검증합니다.
   */
  private static isValidWebhookToken(token: string): boolean {
    const { MIN, MAX } = APP_CONSTANTS.DISCORD.WEBHOOK.TOKEN_LENGTH;
    const regex = new RegExp(`^[a-zA-Z0-9_-]{${MIN},${MAX}}$`);
    return regex.test(token);
  }

  /**
   * 클라이언트 IP 주소를 추출합니다.
   */
  static extractClientIp(req: any): string {
    return (
      req.ip ||
      req.connection?.remoteAddress ||
      req.headers['x-forwarded-for'] ||
      'unknown'
    );
  }

  /**
   * ValidationPipe 설정을 반환합니다.
   */
  static getValidationPipeOptions(): ValidationPipeOptions {
    return {
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (errors: any[]) => {
        const messages = errors.map((error) =>
          Object.values(error.constraints || {}).join(', '),
        );
        return new BadRequestException({
          success: false,
          message: '입력 데이터가 올바르지 않습니다.',
          errors: messages,
        });
      },
    };
  }
}
