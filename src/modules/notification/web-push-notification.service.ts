import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type CachedNotice } from '../../types/cache.types';
import { LoggerUtils } from '../../utils/logger.utils';
import { delayMs } from '../../utils/async-delay.utils';
import { type ChangeNotificationPayload } from './notification.service';
import { WebPushSubscription } from './web-push-subscription.entity';
import { WebPushSubscriptionService } from './web-push-subscription.service';
import { buildFrontendUrl } from './notification-helpers';

type WebPushUrgency = 'very-low' | 'low' | 'normal' | 'normal';

type WebPushLike = {
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(
    subscription: {
      endpoint: string;
      keys: { p256dh: string; auth: string };
    },
    payload: string,
    options?: {
      TTL?: number;
      urgency?: WebPushUrgency;
    },
  ): Promise<unknown>;
};

interface WebPushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
  data?: Record<string, unknown>;
}

export interface WebPushDispatchSummary {
  targetCount: number;
  successCount: number;
  failedCount: number;
  deactivatedCount: number;
}

@Injectable()
export class WebPushNotificationService {
  private readonly logger = LoggerUtils.getContextLogger(
    WebPushNotificationService.name,
  );
  private readonly webPushEnabled: boolean;
  private readonly vapidPublicKey: string;
  private readonly frontendUrls: string[];
  private readonly webPushSendConcurrency = 2;
  private readonly webPushMaxAttempts = 3;
  private readonly webPushRetryBaseDelayMs = 1000;
  private webPushClient: WebPushLike | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly webPushSubscriptionService: WebPushSubscriptionService,
  ) {
    this.webPushEnabled =
      this.configService.get<boolean>('webPush.enabled') === true;
    this.vapidPublicKey =
      this.configService.get<string>('webPush.vapidPublicKey') ?? '';
    this.frontendUrls = this.configService.get<string[]>('frontend.urls') ?? [];
  }

  getPublicConfig(): { enabled: boolean; publicKey: string | null } {
    if (!this.webPushEnabled || !this.vapidPublicKey) {
      return { enabled: false, publicKey: null };
    }

    return {
      enabled: true,
      publicKey: this.vapidPublicKey,
    };
  }

  async sendNewNoticeBatch(
    notice: CachedNotice,
    subscriptions: WebPushSubscription[],
  ): Promise<WebPushDispatchSummary> {
    const url =
      buildFrontendUrl(this.frontendUrls, `/notices/${notice.num}`) ??
      this.frontendUrls[0] ??
      '/';

    return this.sendBatch(
      subscriptions,
      {
        title: '새 입법예고 감지',
        body: `${notice.subject} (${notice.num})`,
        url,
        tag: `lawcast-new-${notice.num}`,
        data: { noticeNum: notice.num, type: 'notice_new' },
      },
      { urgency: 'normal' },
    );
  }

  async sendNewNoticeDigestBatch(
    notices: CachedNotice[],
    subscriptions: WebPushSubscription[],
  ): Promise<WebPushDispatchSummary> {
    const noticeNums = Array.from(new Set(notices.map((notice) => notice.num)));
    const url =
      buildFrontendUrl(this.frontendUrls, '/notices', {
        noticeNums: noticeNums.slice(0, 40).join(','),
      }) ??
      this.frontendUrls[0] ??
      '/';

    return this.sendBatch(
      subscriptions,
      {
        title: `새 입법예고 ${noticeNums.length}건`,
        body: `${noticeNums
          .slice(0, 3)
          .map((num) => `#${num}`)
          .join(', ')}${noticeNums.length > 3 ? ' 외' : ''}`,
        url,
        tag: `lawcast-new-digest-${Date.now()}`,
        data: { noticeNums, type: 'notice_new_digest' },
      },
      { urgency: 'normal' },
    );
  }

  async sendChangeBatch(
    payload: ChangeNotificationPayload,
    subscriptions: WebPushSubscription[],
  ): Promise<WebPushDispatchSummary> {
    const isDoneChanged = payload.changedFields.includes('isDone');
    const url =
      payload.eventHeight && payload.eventHeight > 1
        ? buildFrontendUrl(this.frontendUrls, `/notices/${payload.noticeNum}`, {
            timeline: 'true',
            cmpFrom: String(payload.eventHeight - 1),
            cmpTo: String(payload.eventHeight),
          })
        : buildFrontendUrl(this.frontendUrls, `/notices/${payload.noticeNum}`, {
            timeline: 'true',
          });

    const title = isDoneChanged
      ? '입법예고 기간 종료 감지'
      : payload.isNsmToPalTransition
        ? '국회 입법예고로 이관 감지'
        : '입법예고 변경 감지';
    const type = isDoneChanged
      ? 'notice_period_ended'
      : payload.isNsmToPalTransition
        ? 'notice_nsm_to_pal_transition'
        : 'notice_changed';

    return this.sendBatch(
      subscriptions,
      {
        title,
        body: `${payload.subject} (${payload.noticeNum})`,
        url: url ?? this.frontendUrls[0] ?? '/',
        tag: `lawcast-change-${payload.noticeNum}`,
        data: {
          noticeNum: payload.noticeNum,
          changedFields: payload.changedFields,
          type,
        },
      },
      { urgency: 'normal' },
    );
  }

  async sendChangeDigestBatch(
    payloads: ChangeNotificationPayload[],
    subscriptions: WebPushSubscription[],
    options: { ended: boolean; nsmToPalTransition?: boolean },
  ): Promise<WebPushDispatchSummary> {
    const noticeNums = Array.from(
      new Set(payloads.map((payload) => payload.noticeNum)),
    );
    const url =
      buildFrontendUrl(this.frontendUrls, '/notices/changes') ??
      this.frontendUrls[0] ??
      '/';

    const title = options.ended
      ? `입법예고 종료 ${payloads.length}건`
      : options.nsmToPalTransition
        ? `국회 입법예고로 이관 ${payloads.length}건`
        : `입법예고 변경 ${payloads.length}건`;
    const type = options.ended
      ? 'notice_period_ended_digest'
      : options.nsmToPalTransition
        ? 'notice_nsm_to_pal_transition_digest'
        : 'notice_changed_digest';

    return this.sendBatch(
      subscriptions,
      {
        title,
        body: `${noticeNums.length}개 법률안에서 변경이 감지되었습니다.`,
        url,
        tag: `lawcast-change-digest-${Date.now()}`,
        data: {
          noticeNums,
          eventCount: payloads.length,
          type,
        },
      },
      { urgency: 'normal' },
    );
  }

  private async sendBatch(
    subscriptions: WebPushSubscription[],
    payload: WebPushPayload,
    options: { urgency: WebPushUrgency },
  ): Promise<WebPushDispatchSummary> {
    if (!this.webPushEnabled || subscriptions.length === 0) {
      return {
        targetCount: subscriptions.length,
        successCount: 0,
        failedCount: 0,
        deactivatedCount: 0,
      };
    }

    const webPush = await this.getWebPushClient();
    if (!webPush) {
      return {
        targetCount: subscriptions.length,
        successCount: 0,
        failedCount: subscriptions.length,
        deactivatedCount: 0,
      };
    }

    const serializedPayload = JSON.stringify(payload);

    const results = await this.dispatchWithConcurrency(
      subscriptions,
      async (subscription) =>
        this.sendSingleWithRetry(
          subscription,
          serializedPayload,
          options,
          webPush,
        ),
      Math.min(this.webPushSendConcurrency, subscriptions.length),
    );

    const successCount = results.filter((result) => result.success).length;
    const failedCount = results.length - successCount;
    const deactivatedCount = results.filter(
      (result) => result.deactivated,
    ).length;

    return {
      targetCount: subscriptions.length,
      successCount,
      failedCount,
      deactivatedCount,
    };
  }

  private async sendSingleWithRetry(
    subscription: WebPushSubscription,
    serializedPayload: string,
    options: { urgency: WebPushUrgency },
    webPush: WebPushLike,
  ): Promise<{ success: boolean; deactivated: boolean }> {
    for (let attempt = 1; attempt <= this.webPushMaxAttempts; attempt++) {
      try {
        await webPush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: {
              p256dh: subscription.p256dh,
              auth: subscription.auth,
            },
          },
          serializedPayload,
          {
            TTL: 60 * 60,
            urgency: options.urgency,
          },
        );

        await this.webPushSubscriptionService.markSuccess(subscription.id);
        return { success: true, deactivated: false };
      } catch (error) {
        const statusCode = this.extractStatusCode(error);
        const shouldDeactivate = statusCode === 404 || statusCode === 410;
        const isRetryable = this.isRetryableError(error, statusCode);
        const hasNextAttempt = attempt < this.webPushMaxAttempts;

        if (!shouldDeactivate && isRetryable && hasNextAttempt) {
          const retryDelayMs = this.resolveRetryDelayMs(error, attempt);
          LoggerUtils.debugDev(
            WebPushNotificationService.name,
            `Web push transient failure subscription=${subscription.id} status=${statusCode ?? 'unknown'} retryInMs=${retryDelayMs} attempt=${attempt}/${this.webPushMaxAttempts}`,
          );
          await delayMs(retryDelayMs);
          continue;
        }

        const message = error instanceof Error ? error.message : String(error);

        await this.webPushSubscriptionService.markFailure(
          subscription.id,
          message,
          { deactivate: shouldDeactivate },
        );

        LoggerUtils.debugDev(
          WebPushNotificationService.name,
          `Web push send failed subscription=${subscription.id} status=${statusCode ?? 'unknown'} deactivate=${shouldDeactivate}`,
        );

        return { success: false, deactivated: shouldDeactivate };
      }
    }

    return { success: false, deactivated: false };
  }

  private async dispatchWithConcurrency<T, R>(
    items: T[],
    worker: (item: T, index: number) => Promise<R>,
    concurrency: number,
  ): Promise<R[]> {
    if (items.length === 0) {
      return [];
    }

    const safeConcurrency = Math.max(1, concurrency);
    const results = new Array<R>(items.length);
    let nextIndex = 0;

    const runWorker = async (): Promise<void> => {
      while (true) {
        const current = nextIndex;
        nextIndex += 1;
        if (current >= items.length) {
          return;
        }
        results[current] = await worker(items[current], current);
      }
    };

    await Promise.all(
      Array.from({ length: safeConcurrency }, () => runWorker()),
    );

    return results;
  }

  private isRetryableError(error: unknown, statusCode: number | null): boolean {
    if (
      statusCode &&
      [408, 425, 429, 500, 502, 503, 504].includes(statusCode)
    ) {
      return true;
    }

    const candidate = error as { code?: string };
    return ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN'].includes(
      String(candidate?.code ?? ''),
    );
  }

  private resolveRetryDelayMs(error: unknown, attempt: number): number {
    const retryAfterMs = this.extractRetryAfterMs(error);
    if (retryAfterMs !== null) {
      return retryAfterMs;
    }

    return this.webPushRetryBaseDelayMs * Math.max(1, attempt);
  }

  private extractRetryAfterMs(error: unknown): number | null {
    const candidate = error as {
      headers?: Record<string, unknown>;
      response?: { headers?: Record<string, unknown> };
    };

    const headers = candidate?.headers ?? candidate?.response?.headers;
    if (!headers) {
      return null;
    }

    const rawRetryAfter =
      headers['retry-after'] ??
      headers['Retry-After'] ??
      headers['RETRY-AFTER'];

    if (rawRetryAfter == null) {
      return null;
    }

    const retryAfter = Array.isArray(rawRetryAfter)
      ? String(rawRetryAfter[0])
      : String(rawRetryAfter);

    const parsedSeconds = Number(retryAfter);
    if (Number.isFinite(parsedSeconds)) {
      return Math.max(0, Math.round(parsedSeconds * 1000));
    }

    const retryAt = Date.parse(retryAfter);
    if (!Number.isNaN(retryAt)) {
      return Math.max(0, retryAt - Date.now());
    }

    return null;
  }

  private async getWebPushClient(): Promise<WebPushLike | null> {
    if (!this.webPushEnabled) {
      return null;
    }

    if (this.webPushClient) {
      return this.webPushClient;
    }

    const subject =
      this.configService.get<string>('webPush.subject') ||
      'mailto:lawcast@example.com';
    const publicKey =
      this.configService.get<string>('webPush.vapidPublicKey') || '';
    const privateKey =
      this.configService.get<string>('webPush.vapidPrivateKey') || '';

    if (!publicKey || !privateKey) {
      this.logger.warn(
        'WEB_PUSH_ENABLED is true but VAPID keys are missing. Web push will be disabled.',
      );
      return null;
    }

    const module = (await import('web-push')) as {
      default?: WebPushLike;
      setVapidDetails?: WebPushLike['setVapidDetails'];
      sendNotification?: WebPushLike['sendNotification'];
    };

    const client = (module.default ?? module) as unknown as WebPushLike;
    client.setVapidDetails(subject, publicKey, privateKey);
    this.webPushClient = client;

    return this.webPushClient;
  }

  private extractStatusCode(error: unknown): number | null {
    const candidate = error as {
      statusCode?: number;
      status?: number;
      response?: { status?: number };
    };

    return (
      candidate?.statusCode ??
      candidate?.status ??
      candidate?.response?.status ??
      null
    );
  }
}
