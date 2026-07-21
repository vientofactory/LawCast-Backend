import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MessageBuilder,
  Webhook as DiscordWebhook,
} from 'discord-webhook-node';
import { Webhook } from '../webhook/webhook.entity';
import { APP_CONSTANTS } from '../../config/app.config';
import { CacheService } from '../cache/cache.service';
import { LoggerUtils } from '../../utils/logger.utils';
import { type CachedNotice } from '../../types/cache.types';
import { type ChangeEventType } from '../change-tracking/notice-change-event.entity';
import { type NoticeChangeSource } from '../change-tracking/notice-change-source.enum';
import { buildFrontendUrl } from './notification-helpers';

export interface ChangeNotificationPayload {
  noticeNum: number;
  subject: string;
  eventType: ChangeEventType;
  source?: NoticeChangeSource | null;
  changedFields: string[];
  eventHash: string;
  eventHeight?: number;
  eventId?: number;
  detectedAt?: string;
}

export interface AdminAnnouncementPayload {
  title: string;
  body: string;
  requestedByDisplay?: string;
  requestedByUserId?: string;
  requestedByAvatarUrl?: string;
}

type NotificationSendResult = {
  webhookId: number;
  success: boolean;
  error?: unknown;
  shouldDelete?: boolean;
};

@Injectable()
export class NotificationService {
  private readonly logger = LoggerUtils.getContextLogger(
    NotificationService.name,
  );

  private readonly DEFAULT_NATL_ASSEMBLY_URL =
    'https://pal.assembly.go.kr/napal/lgsltpa/lgsltpaOpn/list.do';
  private readonly MAX_NOTICE_NUMS_IN_DIGEST_URL = 40;
  private readonly PROPOSAL_REASON_MISSING_GUIDANCE =
    '법률안 제안이유를 아직 수집하지 못했습니다. 자세히 보기 링크를 통해 국회 페이지에서 직접 확인해 주세요.';

  // Mapping of change-tracking field paths to user-friendly labels for Discord embeds
  private readonly CHANGE_FIELD_LABELS: Readonly<Record<string, string>> = {
    num: '의안번호',
    subject: '법률안명',
    proposerCategory: '제안자 구분',
    committee: '소관위원회',
    proposalReason: '제안이유',
    billNumber: '입법예고 의안번호',
    proposer: '입법예고 제안자',
    proposalDate: '입법예고 제안일',
    contentCommittee: '입법예고 소관위원회',
    referralDate: '입법예고 회부일',
    noticePeriod: '입법예고 기간',
    proposalSession: '입법예고 제안회기',
    isDone: '처리 상태',
  };

  // Rate limit keys
  private readonly RATE_LIMIT_KEYS = {
    GLOBAL: 'rate_limit:global',
    WEBHOOK: (webhookId: number) => `rate_limit:webhook:${webhookId}`,
  };
  private readonly RATE_LIMIT_TTL_SECONDS = {
    GLOBAL: 60,
    WEBHOOK: 60 * 60,
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
  ): Promise<NotificationSendResult[]> {
    const embed = await this.createNotificationEmbed(notice);
    return this.sendDiscordEmbedBatch(embed, webhooks, {
      username: 'LawCast 알리미',
      context: 'notice notification',
      abortSignal,
    });
  }

  async sendDiscordNotificationDigestBatch(
    notices: CachedNotice[],
    webhooks: Webhook[],
    abortSignal?: AbortSignal,
  ): Promise<NotificationSendResult[]> {
    if (notices.length === 0) {
      return [];
    }

    if (notices.length === 1) {
      return this.sendDiscordNotificationBatch(
        notices[0],
        webhooks,
        abortSignal,
      );
    }

    const embed = this.createNotificationDigestEmbed(notices);
    return this.sendDiscordEmbedBatch(embed, webhooks, {
      username: 'LawCast 알리미',
      context: 'notice digest notification',
      abortSignal,
    });
  }

  /**
   * Sends change-tracking notifications to multiple webhooks.
   * Reuses the same rate-limit controls and permanent-failure handling
   * as the regular notice notification flow.
   */
  async sendDiscordChangeNotificationBatch(
    payload: ChangeNotificationPayload,
    webhooks: Webhook[],
    abortSignal?: AbortSignal,
  ): Promise<NotificationSendResult[]> {
    const embed = this.createChangeNotificationEmbed(payload);
    return this.sendDiscordEmbedBatch(embed, webhooks, {
      username: 'LawCast 변경 추적',
      context: 'change notification',
      abortSignal,
    });
  }

  async sendDiscordNoticePeriodEndedBatch(
    payload: ChangeNotificationPayload,
    webhooks: Webhook[],
    abortSignal?: AbortSignal,
  ): Promise<NotificationSendResult[]> {
    const embed = this.createNoticePeriodEndedEmbed(payload);
    return this.sendDiscordEmbedBatch(embed, webhooks, {
      username: 'LawCast 변경 추적',
      context: 'notice period ended notification',
      abortSignal,
    });
  }

  async sendDiscordChangeDigestNotificationBatch(
    payloads: ChangeNotificationPayload[],
    webhooks: Webhook[],
    abortSignal?: AbortSignal,
  ): Promise<NotificationSendResult[]> {
    if (payloads.length === 0) {
      return [];
    }

    if (payloads.length === 1) {
      return this.sendDiscordChangeNotificationBatch(
        payloads[0],
        webhooks,
        abortSignal,
      );
    }

    const embed = this.createChangeDigestNotificationEmbed(payloads);
    return this.sendDiscordEmbedBatch(embed, webhooks, {
      username: 'LawCast 변경 추적',
      context: 'change digest notification',
      abortSignal,
    });
  }

  async sendDiscordNoticePeriodEndedDigestBatch(
    payloads: ChangeNotificationPayload[],
    webhooks: Webhook[],
    abortSignal?: AbortSignal,
  ): Promise<NotificationSendResult[]> {
    if (payloads.length === 0) {
      return [];
    }

    if (payloads.length === 1) {
      return this.sendDiscordNoticePeriodEndedBatch(
        payloads[0],
        webhooks,
        abortSignal,
      );
    }

    const embed = this.createNoticePeriodEndedDigestEmbed(payloads);
    return this.sendDiscordEmbedBatch(embed, webhooks, {
      username: 'LawCast 변경 추적',
      context: 'notice period ended digest notification',
      abortSignal,
    });
  }

  async sendDiscordAdminAnnouncementBatch(
    payload: AdminAnnouncementPayload,
    webhooks: Webhook[],
    abortSignal?: AbortSignal,
  ): Promise<NotificationSendResult[]> {
    const embed = this.createAdminAnnouncementEmbed(payload);
    return this.sendDiscordEmbedBatch(embed, webhooks, {
      username: 'LawCast 관리자 공지',
      context: 'admin announcement',
      abortSignal,
    });
  }

  private async sendDiscordEmbedBatch(
    embed: MessageBuilder,
    webhooks: Webhook[],
    options: {
      username: string;
      context: string;
      abortSignal?: AbortSignal;
    },
  ): Promise<NotificationSendResult[]> {
    await this.hydrateRateLimitState();

    const results: NotificationSendResult[] = [];

    for (const webhook of webhooks) {
      if (options.abortSignal?.aborted) {
        throw new Error('Notification batch aborted');
      }

      if (this.permanentlyFailedWebhooks.has(webhook.id)) {
        results.push({
          webhookId: webhook.id,
          success: false,
          shouldDelete: true,
          error: new Error('Webhook already marked as permanently failed'),
        });
        continue;
      }

      await this.waitForRateLimit(webhook.id, options.abortSignal);

      try {
        const discordWebhook = new DiscordWebhook(webhook.url);
        discordWebhook.setUsername(options.username);
        await discordWebhook.send(embed);

        await this.updateRateLimitTimestamp(webhook.id);
        this.permanentlyFailedWebhooks.delete(webhook.id);

        results.push({ webhookId: webhook.id, success: true });
      } catch (error) {
        const webhookError = error as {
          response?: { status?: number };
          message?: string;
        };
        const shouldDelete = this.shouldDeleteWebhook(error);

        if (shouldDelete) {
          this.permanentlyFailedWebhooks.add(webhook.id);
          LoggerUtils.debugDev(
            NotificationService.name,
            `Webhook ${webhook.id} permanently failed during ${options.context} (${webhookError.response?.status || 'unknown'})`,
          );
        } else {
          LoggerUtils.debugDev(
            NotificationService.name,
            `Webhook ${webhook.id} temporarily failed during ${options.context}: ${webhookError.message || 'unknown error'}`,
          );
        }

        results.push({
          webhookId: webhook.id,
          success: false,
          error,
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
    const summaryOrGuidance = this.buildSummaryOrGuidanceField(notice);
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

    if (summaryOrGuidance) {
      embed.addField(
        summaryOrGuidance.name,
        this.truncateForEmbed(summaryOrGuidance.value),
        false,
      );
    }

    const detailUrl = this.buildFrontendNoticeDetailUrl(notice);
    embed.addField('자세히 보기', `[입법예고 전문](${detailUrl})`, false);

    return embed;
  }

  private createChangeNotificationEmbed(
    payload: ChangeNotificationPayload,
  ): MessageBuilder {
    const detailUrl =
      payload.eventHeight && payload.eventHeight > 1
        ? this.buildFrontendNoticeDetailUrlByNoticeNum(payload.noticeNum, {
            timeline: 'true',
            cmpFrom: String(payload.eventHeight - 1),
            cmpTo: String(payload.eventHeight),
          })
        : this.buildFrontendNoticeDetailUrlByNoticeNum(payload.noticeNum, {
            timeline: 'true',
          });
    const mappedChangedFields = payload.changedFields.map((fieldPath) =>
      this.getChangeFieldDisplayLabel(fieldPath),
    );
    const changedFieldsPreview =
      payload.changedFields.length > 0
        ? mappedChangedFields.slice(0, 8).join(', ')
        : 'N/A';

    const embed = new MessageBuilder()
      .setTitle('입법예고 변경 감지')
      .setDescription('기존 아카이브 대비 변경 사항이 감지되었습니다.')
      .addField('법률안명', payload.subject, false)
      .addField('의안번호', String(payload.noticeNum), true)
      .addField('변경 필드', this.truncateForEmbed(changedFieldsPreview), true)
      .addField('자세히 보기', `[변경 추적 상세](${detailUrl})`, false)
      .setColor(APP_CONSTANTS.COLORS.DISCORD.PRIMARY)
      .setTimestamp()
      .setFooter('LawCast 알림 서비스', '');

    return embed;
  }

  private createNoticePeriodEndedEmbed(
    payload: ChangeNotificationPayload,
  ): MessageBuilder {
    const detailUrl =
      payload.eventHeight && payload.eventHeight > 1
        ? this.buildFrontendNoticeDetailUrlByNoticeNum(payload.noticeNum, {
            timeline: 'true',
            cmpFrom: String(payload.eventHeight - 1),
            cmpTo: String(payload.eventHeight),
          })
        : this.buildFrontendNoticeDetailUrlByNoticeNum(payload.noticeNum, {
            timeline: 'true',
          });

    return new MessageBuilder()
      .setTitle('입법예고 기간 종료 감지')
      .setDescription(
        '입법예고 기간 종료가 확인되어 처리 상태가 변경되었습니다.',
      )
      .addField('법률안명', payload.subject, false)
      .addField('의안번호', String(payload.noticeNum), true)
      .addField('처리 상태', '입법예고 기간 종료', true)
      .addField('자세히 보기', `[종료 추적 상세](${detailUrl})`, false)
      .setColor(APP_CONSTANTS.COLORS.DISCORD.SUCCESS)
      .setTimestamp()
      .setFooter('LawCast 알림 서비스', '');
  }

  private createChangeDigestNotificationEmbed(
    payloads: ChangeNotificationPayload[],
  ): MessageBuilder {
    const uniqueNoticeNums = Array.from(
      new Set(payloads.map((payload) => payload.noticeNum)),
    );
    const eventIds = payloads
      .map((payload) => payload.eventId)
      .filter(
        (eventId): eventId is number =>
          Number.isInteger(eventId) && eventId > 0,
      );
    const fromEventId = eventIds.length > 0 ? Math.min(...eventIds) : null;
    const toEventId = eventIds.length > 0 ? Math.max(...eventIds) : null;

    const detailParams: Record<string, string> = {
      digest: '1',
      jumpToFirst: '1',
      comparableOnly: 'true',
      excludeLegacyGenesisSource: 'true',
      limit: '50',
    };

    if (fromEventId !== null) {
      detailParams.fromEventId = String(fromEventId);
    }

    if (toEventId !== null) {
      detailParams.toEventId = String(toEventId);
    }

    const detailUrl = this.buildFrontendNoticeChangesUrl(detailParams);

    const itemLines: string[] = [];
    for (const payload of payloads.slice(0, 6)) {
      const changedFieldsPreview = this.buildChangedFieldsPreview(
        payload.changedFields,
      );
      itemLines.push(
        `• **[${payload.noticeNum}]** ${payload.subject} (${changedFieldsPreview})`,
      );
    }

    if (payloads.length > 6) {
      itemLines.push(`... 외 ${payloads.length - 6}건`);
    }

    const embed = new MessageBuilder()
      .setTitle(`입법예고 변경 감지 (${payloads.length}건)`)
      .setDescription(
        `짧은 시간에 감지된 변경 ${payloads.length}건을 하나로 요약했습니다.`,
      )
      .addField(
        '영향 법률안 수',
        `${uniqueNoticeNums.length.toLocaleString()}건`,
        true,
      )
      .addField('자세히 보기', `[변경 내역 모아보기](${detailUrl})`, true)
      .addField('감지 항목', this.truncateForEmbed(itemLines.join('\n')), false)
      .setColor(APP_CONSTANTS.COLORS.DISCORD.PRIMARY)
      .setTimestamp()
      .setFooter('LawCast 알림 서비스', '');

    return embed;
  }

  private createNotificationDigestEmbed(
    notices: CachedNotice[],
  ): MessageBuilder {
    const uniqueNoticeNums = Array.from(
      new Set(notices.map((notice) => notice.num)),
    );
    const noticeNumsForUrl = uniqueNoticeNums.slice(
      0,
      this.MAX_NOTICE_NUMS_IN_DIGEST_URL,
    );
    const detailUrl = this.buildFrontendNoticesUrl({
      digest: '1',
      noticeNums: noticeNumsForUrl.join(','),
      sortOrder: 'desc',
      page: '1',
      limit: '20',
    });

    const itemLines: string[] = [];
    for (const notice of notices.slice(0, 8)) {
      itemLines.push(`• **[${notice.num}]** ${notice.subject}`);
    }

    if (notices.length > 8) {
      itemLines.push(`... 외 ${notices.length - 8}건`);
    }

    const description = [
      `최근에 ${notices.length.toLocaleString()}개 법률안이 신규 감지되었습니다.`,
      'AI 요약과 법률안 원문을 확인하려면 아래 링크를 클릭하세요.',
    ].join('\n');

    return new MessageBuilder()
      .setTitle(`입법예고 신규 감지 (${notices.length}건)`)
      .setDescription(description)
      .addField('자세히 보기', `[신규 항목 모아보기](${detailUrl})`, false)
      .addField('감지 항목', this.truncateForEmbed(itemLines.join('\n')), false)
      .setColor(APP_CONSTANTS.COLORS.DISCORD.PRIMARY)
      .setTimestamp()
      .setFooter('LawCast 알림 서비스', '');
  }

  private createNoticePeriodEndedDigestEmbed(
    payloads: ChangeNotificationPayload[],
  ): MessageBuilder {
    const uniqueNoticeNums = Array.from(
      new Set(payloads.map((payload) => payload.noticeNum)),
    );
    const eventIds = payloads
      .map((payload) => payload.eventId)
      .filter(
        (eventId): eventId is number =>
          Number.isInteger(eventId) && eventId > 0,
      );
    const fromEventId = eventIds.length > 0 ? Math.min(...eventIds) : null;
    const toEventId = eventIds.length > 0 ? Math.max(...eventIds) : null;

    const detailParams: Record<string, string> = {
      digest: '1',
      jumpToFirst: '1',
      comparableOnly: 'true',
      excludeLegacyGenesisSource: 'true',
      limit: '50',
    };

    if (fromEventId !== null) {
      detailParams.fromEventId = String(fromEventId);
    }

    if (toEventId !== null) {
      detailParams.toEventId = String(toEventId);
    }

    const detailUrl = this.buildFrontendNoticeChangesUrl(detailParams);

    const itemLines: string[] = [];
    for (const payload of payloads.slice(0, 6)) {
      itemLines.push(`• **[${payload.noticeNum}]** ${payload.subject}`);
    }

    if (payloads.length > 6) {
      itemLines.push(`... 외 ${payloads.length - 6}건`);
    }

    return new MessageBuilder()
      .setTitle(`입법예고 기간 종료 감지 (${payloads.length}건)`)
      .setDescription(
        `입법예고 기간 종료가 확인된 ${payloads.length.toLocaleString()}건을 하나로 요약했습니다.`,
      )
      .addField(
        '영향 법률안 수',
        `${uniqueNoticeNums.length.toLocaleString()}건`,
        true,
      )
      .addField('자세히 보기', `[종료 내역 모아보기](${detailUrl})`, true)
      .addField('종료 항목', this.truncateForEmbed(itemLines.join('\n')), false)
      .setColor(APP_CONSTANTS.COLORS.DISCORD.SUCCESS)
      .setTimestamp()
      .setFooter('LawCast 알림 서비스', '');
  }

  private buildChangedFieldsPreview(changedFields: string[]): string {
    if (changedFields.length === 0) {
      return '변경 필드 없음';
    }

    const mapped = changedFields.map((fieldPath) =>
      this.getChangeFieldDisplayLabel(fieldPath),
    );

    const preview = mapped.slice(0, 4).join(', ');
    if (mapped.length <= 4) {
      return preview;
    }

    return `${preview} 외 ${mapped.length - 4}`;
  }

  private createAdminAnnouncementEmbed(
    payload: AdminAnnouncementPayload,
  ): MessageBuilder {
    const title = payload.title.trim();
    const body = payload.body.trim();
    const requestedByDisplay = payload.requestedByDisplay?.trim() || '관리자';
    const requestedByAvatarUrl = payload.requestedByAvatarUrl?.trim();
    const prefixedTitle = `[공지] ${title}`;

    return new MessageBuilder()
      .setTitle(this.truncateForEmbed(prefixedTitle, 256))
      .setDescription(this.truncateForEmbed(body, 4000))
      .setColor(APP_CONSTANTS.COLORS.DISCORD.SUCCESS)
      .setTimestamp()
      .setFooter(requestedByDisplay, requestedByAvatarUrl);
  }

  private getChangeFieldDisplayLabel(fieldPath: string): string {
    return this.CHANGE_FIELD_LABELS[fieldPath] ?? `기타(${fieldPath})`;
  }

  private buildSummaryOrGuidanceField(
    notice: CachedNotice,
  ): { name: string; value: string } | null {
    const precomputedSummary = notice.aiSummary;

    if (precomputedSummary) {
      return {
        name: '핵심 내용 AI 요약',
        value: precomputedSummary.trim(),
      };
    }

    if (this.isProposalReasonMissing(notice)) {
      return {
        name: '안내',
        value: this.PROPOSAL_REASON_MISSING_GUIDANCE,
      };
    }

    return null;
  }

  private isProposalReasonMissing(notice: CachedNotice): boolean {
    const reason = notice.proposalReason?.trim();
    return notice.contentId === null && !reason;
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
    const detailUrl = buildFrontendUrl(frontendUrls, `/notices/${notice.num}`);
    if (!detailUrl) {
      return notice.link;
    }

    return detailUrl;
  }

  private buildFrontendNoticeDetailUrlByNoticeNum(
    noticeNum: number,
    params?: Record<string, string>,
  ): string {
    const frontendUrls =
      this.configService.get<string[]>('frontend.urls') || [];
    const detailUrl = buildFrontendUrl(
      frontendUrls,
      `/notices/${noticeNum}`,
      params,
    );
    if (!detailUrl) {
      return this.DEFAULT_NATL_ASSEMBLY_URL;
    }

    return detailUrl;
  }

  private buildFrontendNoticeChangesUrl(
    params?: Record<string, string>,
  ): string {
    const frontendUrls =
      this.configService.get<string[]>('frontend.urls') || [];

    return (
      buildFrontendUrl(frontendUrls, '/notices/changes', params) ??
      this.DEFAULT_NATL_ASSEMBLY_URL
    );
  }

  private buildFrontendNoticesUrl(params?: Record<string, string>): string {
    const frontendUrls =
      this.configService.get<string[]>('frontend.urls') || [];
    const noticesUrl = buildFrontendUrl(frontendUrls, '/notices', params);
    if (!noticesUrl) {
      return this.DEFAULT_NATL_ASSEMBLY_URL;
    }

    return noticesUrl;
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
      this.cacheService.setNumber(
        this.RATE_LIMIT_KEYS.GLOBAL,
        now,
        this.RATE_LIMIT_TTL_SECONDS.GLOBAL,
      ),
      this.cacheService.setNumber(
        this.RATE_LIMIT_KEYS.WEBHOOK(webhookId),
        now,
        this.RATE_LIMIT_TTL_SECONDS.WEBHOOK,
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
    this.webhookLastSendAt.delete(webhookId);

    void this.cacheService.deleteKey(this.RATE_LIMIT_KEYS.WEBHOOK(webhookId));

    LoggerUtils.debugDev(
      NotificationService.name,
      `Cleared permanent failure flag for webhook ${webhookId}`,
    );
  }
}
