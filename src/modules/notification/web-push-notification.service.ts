import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type CachedNotice } from '../../types/cache.types';
import { LoggerUtils } from '../../utils/logger.utils';
import { type ChangeNotificationPayload } from './notification.service';
import { WebPushSubscription } from './web-push-subscription.entity';
import { WebPushSubscriptionService } from './web-push-subscription.service';
import { buildFrontendUrl } from './notification-helpers';

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
      urgency?: 'very-low' | 'low' | 'normal' | 'high';
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

    return this.sendBatch(
      subscriptions,
      {
        title: isDoneChanged ? '입법예고 기간 종료 감지' : '입법예고 변경 감지',
        body: `${payload.subject} (${payload.noticeNum})`,
        url: url ?? this.frontendUrls[0] ?? '/',
        tag: `lawcast-change-${payload.noticeNum}`,
        data: {
          noticeNum: payload.noticeNum,
          changedFields: payload.changedFields,
          type: isDoneChanged ? 'notice_period_ended' : 'notice_changed',
        },
      },
      { urgency: 'high' },
    );
  }

  async sendChangeDigestBatch(
    payloads: ChangeNotificationPayload[],
    subscriptions: WebPushSubscription[],
    options: { ended: boolean },
  ): Promise<WebPushDispatchSummary> {
    const noticeNums = Array.from(
      new Set(payloads.map((payload) => payload.noticeNum)),
    );
    const url =
      buildFrontendUrl(this.frontendUrls, '/notices/changes') ??
      this.frontendUrls[0] ??
      '/';

    return this.sendBatch(
      subscriptions,
      {
        title: options.ended
          ? `입법예고 종료 ${payloads.length}건`
          : `입법예고 변경 ${payloads.length}건`,
        body: `${noticeNums.length}개 법률안에서 변경이 감지되었습니다.`,
        url,
        tag: `lawcast-change-digest-${Date.now()}`,
        data: {
          noticeNums,
          eventCount: payloads.length,
          type: options.ended
            ? 'notice_period_ended_digest'
            : 'notice_changed_digest',
        },
      },
      { urgency: 'high' },
    );
  }

  private async sendBatch(
    subscriptions: WebPushSubscription[],
    payload: WebPushPayload,
    options: { urgency: 'very-low' | 'low' | 'normal' | 'high' },
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

    const results = await Promise.all(
      subscriptions.map(async (subscription) => {
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
          const message =
            error instanceof Error ? error.message : String(error);
          const shouldDeactivate = statusCode === 404 || statusCode === 410;

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
      }),
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
