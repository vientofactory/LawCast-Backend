import { Injectable, Logger } from '@nestjs/common';
import {
  MessageBuilder,
  Webhook as DiscordWebhook,
} from 'discord-webhook-node';
import { type ITableData } from 'pal-crawl';
import { Webhook } from '../entities/webhook.entity';
import { APP_CONSTANTS } from '../config/app.config';
import { CacheService } from './cache.service';
import { LoggerUtils } from '../utils/logger.utils';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  // 레이트 리밋 키
  private readonly RATE_LIMIT_KEYS = {
    GLOBAL: 'rate_limit:global',
    WEBHOOK: (webhookId: number) => `rate_limit:webhook:${webhookId}`,
  };

  // 영구적으로 실패한 웹훅들을 추적하여 중복 시도 방지
  private readonly permanentlyFailedWebhooks = new Set<number>();

  constructor(private cacheService: CacheService) {}

  async sendDiscordNotification(
    notice: ITableData,
    webhooks: Webhook[],
  ): Promise<void> {
    const embed = this.createNotificationEmbed(notice);

    for (const webhook of webhooks) {
      try {
        const discordWebhook = new DiscordWebhook(webhook.url);
        discordWebhook.setUsername('LawCast 알리미');

        await discordWebhook.send(embed);
      } catch (error) {
        this.logger.error(
          `Failed to send notification to webhook ${webhook.id}:`,
          error,
        );
      }
    }
  }

  /**
   * 병렬로 여러 웹훅에 알림을 전송하고 결과를 반환
   */
  async sendDiscordNotificationBatch(
    notice: ITableData,
    webhooks: Webhook[],
  ): Promise<
    Array<{
      webhookId: number;
      success: boolean;
      error?: any;
      shouldDelete?: boolean;
    }>
  > {
    const embed = this.createNotificationEmbed(notice);
    const results: Array<{
      webhookId: number;
      success: boolean;
      error?: any;
      shouldDelete?: boolean;
    }> = [];

    // Discord 레이트 리밋을 준수하며 순차적으로 처리
    for (const webhook of webhooks) {
      // 이미 영구적으로 실패한 웹훅은 건너뛰기
      if (this.permanentlyFailedWebhooks.has(webhook.id)) {
        results.push({
          webhookId: webhook.id,
          success: false,
          shouldDelete: true,
          error: new Error('Webhook already marked as permanently failed'),
        });
        continue;
      }

      // 레이트 리밋 준수를 위한 대기
      await this.waitForRateLimit(webhook.id);

      try {
        const discordWebhook = new DiscordWebhook(webhook.url);
        discordWebhook.setUsername('LawCast 알리미');

        await discordWebhook.send(embed);

        // 성공 시 마지막 전송 시간 기록
        await this.updateRateLimitTimestamp(webhook.id);

        // 성공한 경우 실패 목록에서 제거
        this.permanentlyFailedWebhooks.delete(webhook.id);

        results.push({ webhookId: webhook.id, success: true });
      } catch (error) {
        const shouldDelete = this.shouldDeleteWebhook(error);

        if (shouldDelete) {
          // 영구 실패 시 즉시 실패 목록에 추가하여 향후 재시도 방지
          this.permanentlyFailedWebhooks.add(webhook.id);

          LoggerUtils.debugDev(
            NotificationService.name,
            `Webhook ${webhook.id} permanently failed on first attempt (${error.response?.status || 'unknown'}) - marked for immediate deactivation`,
          );
        } else {
          this.logger.debug(
            `Webhook ${webhook.id} temporarily failed: ${error.message}`,
          );
        }

        results.push({
          webhookId: webhook.id,
          success: false,
          error: error,
          shouldDelete,
        });
      }
    }

    return results;
  }

  /**
   * 알림 임베드 메시지를 생성
   */
  private createNotificationEmbed(notice: ITableData): MessageBuilder {
    return new MessageBuilder()
      .setTitle('새로운 국회 입법예고')
      .setDescription(
        '새로운 입법예고가 감지되었습니다. 아래 정보를 확인하세요.',
      )
      .addField('법률안명', notice.subject, false)
      .addField('제안자 구분', notice.proposerCategory, true)
      .addField('소관위원회', notice.committee, true)
      .addField('자세히 보기', `[링크 바로가기](${notice.link})`, false)
      .setColor(APP_CONSTANTS.COLORS.DISCORD.PRIMARY)
      .setTimestamp()
      .setFooter('LawCast 알림 서비스', '');
  }

  /**
   * 웹훅 에러를 분석하여 삭제 여부를 결정
   */
  private shouldDeleteWebhook(error: any): boolean {
    // Discord API 에러 코드를 확인
    if (error.response?.status) {
      const status = error.response.status;
      const { NOT_FOUND, UNAUTHORIZED, FORBIDDEN } =
        APP_CONSTANTS.DISCORD.API.ERROR_CODES;

      // 404: 웹훅이 삭제됨, 401: 권한 없음, 403: 차단됨
      return [NOT_FOUND, UNAUTHORIZED, FORBIDDEN].includes(status);
    }

    // discord-webhook-node 라이브러리의 에러 메시지에서 status code 추출
    if (error.message && typeof error.message === 'string') {
      const message = error.message;

      // "404 status code" 패턴 확인
      const statusMatch = message.match(/(\d{3}) status code/);
      if (statusMatch) {
        const status = parseInt(statusMatch[1]);
        const { NOT_FOUND, UNAUTHORIZED, FORBIDDEN } =
          APP_CONSTANTS.DISCORD.API.ERROR_CODES;

        return (
          status === NOT_FOUND ||
          status === UNAUTHORIZED ||
          status === FORBIDDEN
        );
      }

      // Discord API 에러 코드 확인 (응답 JSON에서)
      const codeMatch = message.match(/"code":\s*(\d+)/);
      if (codeMatch) {
        const code = parseInt(codeMatch[1]);
        // Discord webhook unknown error codes
        const permanentErrorCodes = [10015]; // Unknown Webhook
        return permanentErrorCodes.includes(code);
      }
    }

    // 네트워크 오류나 일시적 오류는 삭제하지 않음
    return false;
  }

  async testWebhook(webhookUrl: string): Promise<{
    success: boolean;
    shouldDelete: boolean;
    error?: any;
    errorType?: string;
  }> {
    try {
      const discordWebhook = new DiscordWebhook(webhookUrl);
      discordWebhook.setUsername('LawCast 알리미');

      const description = [
        '웹훅이 정상적으로 설정되었습니다!',
        '새로운 입법예고가 감지되면 이 채널로 알림을 받게 됩니다.',
        '알림 수신을 원치 않으실 경우 언제든지 웹훅을 삭제하실 수 있습니다.',
      ].join('\n');

      const testEmbed = new MessageBuilder()
        .setTitle('LawCast 웹훅 테스트')
        .setDescription(description)
        .setColor(APP_CONSTANTS.COLORS.DISCORD.SUCCESS)
        .setTimestamp()
        .setFooter('LawCast 알림 서비스', '');

      await discordWebhook.send(testEmbed);
      return { success: true, shouldDelete: false };
    } catch (error) {
      this.logger.error('Failed to send test webhook notification:', error);
      const errorType = this.categorizeWebhookError(error);

      return {
        success: false,
        shouldDelete: this.shouldDeleteWebhook(error),
        error,
        errorType,
      };
    }
  }

  /**
   * 웹훅 에러를 카테고리별로 분류
   */
  private categorizeWebhookError(error: any): string {
    // axios 스타일 에러 처리
    if (error.response?.status) {
      const status = error.response.status;
      const { NOT_FOUND, UNAUTHORIZED, FORBIDDEN, TOO_MANY_REQUESTS } =
        APP_CONSTANTS.DISCORD.API.ERROR_CODES;

      switch (status) {
        case NOT_FOUND:
          return 'NOT_FOUND';
        case UNAUTHORIZED:
          return 'UNAUTHORIZED';
        case FORBIDDEN:
          return 'FORBIDDEN';
        case TOO_MANY_REQUESTS:
          return 'RATE_LIMITED';
        default:
          return 'INVALID_WEBHOOK';
      }
    }

    // discord-webhook-node 라이브러리의 에러 메시지에서 정보 추출
    if (error.message && typeof error.message === 'string') {
      const message = error.message;

      // HTTP status code 추출
      const statusMatch = message.match(/(\d{3}) status code/);
      if (statusMatch) {
        const status = parseInt(statusMatch[1]);
        const { NOT_FOUND, UNAUTHORIZED, FORBIDDEN, TOO_MANY_REQUESTS } =
          APP_CONSTANTS.DISCORD.API.ERROR_CODES;

        switch (status) {
          case NOT_FOUND:
            return 'NOT_FOUND';
          case UNAUTHORIZED:
            return 'UNAUTHORIZED';
          case FORBIDDEN:
            return 'FORBIDDEN';
          case TOO_MANY_REQUESTS:
            return 'RATE_LIMITED';
          default:
            return 'INVALID_WEBHOOK';
        }
      }

      // Discord API 에러 코드 추출
      const codeMatch = message.match(/"code":\s*(\d+)/);
      if (codeMatch) {
        const code = parseInt(codeMatch[1]);
        switch (code) {
          case 10015:
            return 'UNKNOWN_WEBHOOK';
          default:
            return 'DISCORD_API_ERROR';
        }
      }
    }

    // 네트워크 관련 에러
    if (
      error.code === 'ENOTFOUND' ||
      error.code === 'ECONNREFUSED' ||
      error.code === 'ETIMEDOUT'
    ) {
      return 'NETWORK_ERROR';
    }

    // URL 파싱 에러나 기타 클라이언트 에러
    if (
      error.message?.includes('Invalid URL') ||
      error.message?.includes('webhook')
    ) {
      return 'INVALID_WEBHOOK';
    }

    return 'UNKNOWN_ERROR';
  }

  /**
   * Discord 레이트 리밋을 준수하기 위해 필요한 대기 시간을 계산하고 대기
   */
  private async waitForRateLimit(webhookId: number): Promise<void> {
    const now = Date.now();
    const { GLOBAL_PER_SECOND, PER_WEBHOOK_PER_MINUTE } =
      APP_CONSTANTS.DISCORD.API.RATE_LIMITS;

    // Redis에서 글로벌 마지막 전송 시간 가져오기
    const lastGlobalSend = await this.getGlobalLastSendTime();
    const timeSinceLastGlobal = now - lastGlobalSend;
    const globalWaitTime = Math.max(
      0,
      1000 / GLOBAL_PER_SECOND - timeSinceLastGlobal,
    );

    // Redis에서 웹훅별 마지막 전송 시간 가져오기
    const lastWebhookSend = await this.getWebhookLastSendTime(webhookId);
    const timeSinceLastWebhook = now - lastWebhookSend;
    const webhookWaitTime = Math.max(
      0,
      (60 * 1000) / PER_WEBHOOK_PER_MINUTE - timeSinceLastWebhook,
    );

    // 더 긴 대기 시간 적용
    const waitTime = Math.max(globalWaitTime, webhookWaitTime);

    if (waitTime > 0) {
      this.logger.debug(
        `Rate limit wait: ${waitTime}ms for webhook ${webhookId} (global: ${globalWaitTime}ms, webhook: ${webhookWaitTime}ms)`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
  }

  /**
   * Redis에서 글로벌 마지막 전송 시간을 가져옴
   */
  private async getGlobalLastSendTime(): Promise<number> {
    try {
      const lastSend = await this.cacheService['cacheManager'].get<number>(
        this.RATE_LIMIT_KEYS.GLOBAL,
      );
      return lastSend || 0;
    } catch (error) {
      this.logger.warn(
        'Failed to get global rate limit timestamp from Redis:',
        error,
      );
      return 0;
    }
  }

  /**
   * Redis에서 웹훅별 마지막 전송 시간을 가져옴
   */
  private async getWebhookLastSendTime(webhookId: number): Promise<number> {
    try {
      const lastSend = await this.cacheService['cacheManager'].get<number>(
        this.RATE_LIMIT_KEYS.WEBHOOK(webhookId),
      );
      return lastSend || 0;
    } catch (error) {
      this.logger.warn(
        `Failed to get webhook ${webhookId} rate limit timestamp from Redis:`,
        error,
      );
      return 0;
    }
  }

  /**
   * 레이트 리밋 타임스탬프를 Redis에 업데이트
   */
  private async updateRateLimitTimestamp(webhookId: number): Promise<void> {
    const now = Date.now();

    try {
      // 글로벌 타임스탬프 업데이트
      await this.cacheService['cacheManager'].set(
        this.RATE_LIMIT_KEYS.GLOBAL,
        now,
        0,
      );

      // 웹훅별 타임스탬프 업데이트
      await this.cacheService['cacheManager'].set(
        this.RATE_LIMIT_KEYS.WEBHOOK(webhookId),
        now,
        0,
      );
    } catch (error) {
      this.logger.error(
        'Failed to update rate limit timestamps in Redis:',
        error,
      );
      // Redis 실패 시에도 계속 진행 (메모리 기반 폴백은 제거)
    }
  }

  /**
   * 웹훅이 삭제될 때 실패 목록에서 제거
   */
  clearPermanentFailureFlag(webhookId: number): void {
    this.permanentlyFailedWebhooks.delete(webhookId);
    this.logger.debug(
      `Cleared permanent failure flag for webhook ${webhookId}`,
    );
  }

  /**
   * 영구적으로 실패한 웹훅 목록 반환 (디버깅/모니터링용)
   */
  getPermanentlyFailedWebhooks(): number[] {
    return Array.from(this.permanentlyFailedWebhooks);
  }
}
