import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MessageBuilder,
  Webhook as DiscordWebhook,
} from 'discord-webhook-node';
import { Webhook } from '../entities/webhook.entity';
import { APP_CONSTANTS } from '../config/app.config';
import { CacheService } from './cache.service';
import { LoggerUtils } from '../utils/logger.utils';
import { type CachedNotice } from '../types/cache.types';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  // Rate limit keys
  private readonly RATE_LIMIT_KEYS = {
    GLOBAL: 'rate_limit:global',
    WEBHOOK: (webhookId: number) => `rate_limit:webhook:${webhookId}`,
  };

  // Tracks permanently failed webhooks to prevent duplicate attempts
  private readonly permanentlyFailedWebhooks = new Set<number>();
  private globalLastSendAt = 0;
  private readonly webhookLastSendAt = new Map<number, number>();
  private isRateLimitStateHydrated = false;

  constructor(
    private cacheService: CacheService,
    private configService: ConfigService,
  ) {}

  /**
   * Sends notifications to multiple webhooks in parallel and returns the results.
   * @param notice The cached notice to be sent.
   * @param webhooks The array of webhooks to send the notification to.
   * @param abortSignal Optional signal to abort the batch operation.
   * @returns A promise that resolves to an array of results for each webhook.
   */
  async sendDiscordNotificationBatch(
    notice: CachedNotice,
    webhooks: Webhook[],
    abortSignal?: AbortSignal,
  ): Promise<
    Array<{
      webhookId: number;
      success: boolean;
      error?: unknown;
      shouldDelete?: boolean;
    }>
  > {
    await this.hydrateRateLimitState();

    const embed = await this.createNotificationEmbed(notice);
    const results: Array<{
      webhookId: number;
      success: boolean;
      error?: unknown;
      shouldDelete?: boolean;
    }> = [];

    // Process webhooks sequentially while respecting Discord rate limits
    for (const webhook of webhooks) {
      if (abortSignal?.aborted) {
        throw new Error('Notification batch aborted');
      }

      // Skip webhooks that have already permanently failed
      if (this.permanentlyFailedWebhooks.has(webhook.id)) {
        results.push({
          webhookId: webhook.id,
          success: false,
          shouldDelete: true,
          error: new Error('Webhook already marked as permanently failed'),
        });
        continue;
      }

      // Wait for rate limit if necessary before sending the notification
      await this.waitForRateLimit(webhook.id, abortSignal);

      try {
        const discordWebhook = new DiscordWebhook(webhook.url);
        discordWebhook.setUsername('LawCast 알리미');

        await discordWebhook.send(embed);

        // Record the last send time on success
        await this.updateRateLimitTimestamp(webhook.id);

        // Remove from the permanently failed list on success
        this.permanentlyFailedWebhooks.delete(webhook.id);

        results.push({ webhookId: webhook.id, success: true });
      } catch (error) {
        const webhookError = error as {
          response?: { status?: number };
          message?: string;
        };
        const shouldDelete = this.shouldDeleteWebhook(error);

        if (shouldDelete) {
          // Mark this webhook as permanently failed to avoid future attempts
          this.permanentlyFailedWebhooks.add(webhook.id);

          LoggerUtils.debugDev(
            NotificationService.name,
            `Webhook ${webhook.id} permanently failed on first attempt (${webhookError.response?.status || 'unknown'}) - marked for immediate deactivation`,
          );
        } else {
          LoggerUtils.debugDev(
            NotificationService.name,
            `Webhook ${webhook.id} temporarily failed: ${webhookError.message || 'unknown error'}`,
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
   * Creates a notification embed message.
   * @param notice The cached notice to be included in the embed.
   * @returns A promise that resolves to a MessageBuilder instance.
   */
  private async createNotificationEmbed(
    notice: CachedNotice,
  ): Promise<MessageBuilder> {
    const summary = this.buildProposalSummary(notice);
    const embed = new MessageBuilder()
      .setTitle('새로운 국회 입법예고')
      .setDescription(
        '새로운 입법예고가 감지되었습니다. 아래 정보를 확인하세요.',
      )
      .addField('법률안명', notice.subject, false)
      .addField('제안자 구분', notice.proposerCategory, true)
      .addField('소관위원회', notice.committee, true)
      .setColor(APP_CONSTANTS.COLORS.DISCORD.PRIMARY)
      .setTimestamp()
      .setFooter('LawCast 알림 서비스', '');

    if (summary) {
      embed.addField(
        '핵심 내용 AI 요약',
        this.truncateForEmbed(summary),
        false,
      );
    }

    const detailUrl = this.buildFrontendNoticeDetailUrl(notice);
    embed.addField('자세히 보기', `[입법예고 전문](${detailUrl})`, false);

    return embed;
  }

  private buildProposalSummary(notice: CachedNotice): string | null {
    const precomputedSummary = notice.aiSummary;

    if (precomputedSummary) {
      return precomputedSummary.trim();
    }

    return null;
  }

  private truncateForEmbed(value: string, maxLength = 1024): string {
    if (value.length <= maxLength) {
      return value;
    }

    return `${value.slice(0, maxLength - 3)}...`;
  }

  private buildFrontendNoticeDetailUrl(notice: CachedNotice): string {
    const frontendUrls =
      this.configService.get<string[]>('frontend.urls') || [];
    const primaryFrontendUrl = frontendUrls.find((url) => !!url?.trim());

    if (!primaryFrontendUrl) {
      return notice.link;
    }

    const normalizedBaseUrl = primaryFrontendUrl.replace(/\/+$/, '');
    return `${normalizedBaseUrl}/notices/${notice.num}`;
  }

  /**
   * Determines whether a webhook should be deleted based on the error.
   * @param error The error object to analyze.
   * @returns A boolean indicating whether the webhook should be deleted.
   */
  private shouldDeleteWebhook(error: any): boolean {
    if (error.response?.status) {
      const status = error.response.status;
      const { NOT_FOUND, UNAUTHORIZED, FORBIDDEN } =
        APP_CONSTANTS.DISCORD.API.ERROR_CODES;

      return [NOT_FOUND, UNAUTHORIZED, FORBIDDEN].includes(status);
    }

    if (error.message && typeof error.message === 'string') {
      const message = error.message;

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

      const codeMatch = message.match(/"code":\s*(\d+)/);
      if (codeMatch) {
        const code = parseInt(codeMatch[1]);
        // Discord webhook unknown error codes
        const permanentErrorCodes = [10015]; // Unknown Webhook
        return permanentErrorCodes.includes(code);
      }
    }

    return false;
  }

  /**
   * Tests a webhook by sending a test notification.
   * @param webhookUrl The URL of the webhook to test.
   * @returns An object containing the test result, including success status, deletion recommendation, and error details if any.
   */
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
   * Categorizes a webhook error into specific types.
   * @param error The error object to categorize.
   * @returns A string representing the error category.
   */
  private categorizeWebhookError(error: any): string {
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

    // Extract information from discord-webhook-node library error messages
    if (error.message && typeof error.message === 'string') {
      const message = error.message;

      // Extract HTTP status code
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

      // Extract Discord API error codes
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

    // Network-related errors
    if (
      error.code === 'ENOTFOUND' ||
      error.code === 'ECONNREFUSED' ||
      error.code === 'ETIMEDOUT'
    ) {
      return 'NETWORK_ERROR';
    }

    // URL parsing errors or other client errors
    if (
      error.message?.includes('Invalid URL') ||
      error.message?.includes('webhook')
    ) {
      return 'INVALID_WEBHOOK';
    }

    return 'UNKNOWN_ERROR';
  }

  /**
   * Calculates the necessary wait time to comply with Discord rate limits and waits.
   * @param webhookId The ID of the webhook to check rate limits for.
   * @param abortSignal Optional AbortSignal to cancel the wait.
   */
  private async waitForRateLimit(
    webhookId: number,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const now = Date.now();
    const { GLOBAL_PER_SECOND, PER_WEBHOOK_PER_MINUTE } =
      APP_CONSTANTS.DISCORD.API.RATE_LIMITS;

    const lastGlobalSend = this.globalLastSendAt;
    const timeSinceLastGlobal = now - lastGlobalSend;
    const globalWaitTime = Math.max(
      0,
      1000 / GLOBAL_PER_SECOND - timeSinceLastGlobal,
    );

    const lastWebhookSend = this.webhookLastSendAt.get(webhookId) ?? 0;
    const timeSinceLastWebhook = now - lastWebhookSend;
    const webhookWaitTime = Math.max(
      0,
      (60 * 1000) / PER_WEBHOOK_PER_MINUTE - timeSinceLastWebhook,
    );

    // More restrictive wait time applies
    const waitTime = Math.max(globalWaitTime, webhookWaitTime);

    if (waitTime > 0) {
      LoggerUtils.debugDev(
        NotificationService.name,
        `Rate limit wait: ${waitTime.toFixed(2)}ms for webhook ${webhookId} (global: ${globalWaitTime.toFixed(2)}ms, webhook: ${webhookWaitTime.toFixed(2)}ms)`,
      );
      await this.waitWithAbort(waitTime, abortSignal);
    }
  }

  /**
   * Updates the rate limit timestamps in Redis.
   * @param webhookId The ID of the webhook to update the rate limit for.
   */
  private async updateRateLimitTimestamp(webhookId: number): Promise<void> {
    const now = Date.now();
    this.globalLastSendAt = now;
    this.webhookLastSendAt.set(webhookId, now);

    await Promise.all([
      this.cacheService.setNumber(this.RATE_LIMIT_KEYS.GLOBAL, now, 0),
      this.cacheService.setNumber(
        this.RATE_LIMIT_KEYS.WEBHOOK(webhookId),
        now,
        0,
      ),
    ]);
  }

  /**
   * Hydrates the rate limit state from Redis.
   * This ensures that the service has the latest rate limit timestamps.
   */
  private async hydrateRateLimitState(): Promise<void> {
    if (this.isRateLimitStateHydrated) {
      return;
    }

    const globalLastSend = await this.cacheService.getNumber(
      this.RATE_LIMIT_KEYS.GLOBAL,
    );

    this.globalLastSendAt = globalLastSend ?? 0;
    this.isRateLimitStateHydrated = true;
  }

  /**
   * Waits for the specified duration, with support for aborting via an AbortSignal.
   * @param ms The duration to wait in milliseconds.
   * @param abortSignal Optional AbortSignal to cancel the wait.
   * @returns A promise that resolves after the wait or rejects if aborted.
   */
  private waitWithAbort(ms: number, abortSignal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (abortSignal?.aborted) {
        reject(new Error('Notification batch aborted'));
        return;
      }

      const timeoutId = setTimeout(() => {
        abortSignal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);

      const onAbort = () => {
        clearTimeout(timeoutId);
        abortSignal?.removeEventListener('abort', onAbort);
        reject(new Error('Notification batch aborted'));
      };

      abortSignal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Clears the permanent failure flag for a webhook when it is deleted.
   * @param webhookId The ID of the webhook to clear the flag for.
   */
  clearPermanentFailureFlag(webhookId: number): void {
    this.permanentlyFailedWebhooks.delete(webhookId);
    LoggerUtils.debugDev(
      NotificationService.name,
      `Cleared permanent failure flag for webhook ${webhookId}`,
    );
  }
}
