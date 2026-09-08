import { WebPushNotificationService } from './web-push-notification.service';
import { WebPushSubscription } from './web-push-subscription.entity';

describe('WebPushNotificationService', () => {
  const baseConfig = {
    webPushEnabled: true,
    webPushVapidPublicKey: 'test-public-key',
    webPushVapidPrivateKey: 'test-private-key',
    webPushSubject: 'mailto:test@example.com',
    frontendUrls: ['http://localhost:5173'],
  };

  function createService(overrides: Partial<typeof baseConfig> = {}) {
    const config = { ...baseConfig, ...overrides };
    const configService = {
      get: jest.fn((key: string) => {
        switch (key) {
          case 'webPush.enabled':
            return config.webPushEnabled;
          case 'webPush.vapidPublicKey':
            return config.webPushVapidPublicKey;
          case 'webPush.vapidPrivateKey':
            return config.webPushVapidPrivateKey;
          case 'webPush.subject':
            return config.webPushSubject;
          case 'frontend.urls':
            return config.frontendUrls;
          default:
            return undefined;
        }
      }),
    };

    const webPushSubscriptionService = {
      markSuccess: jest.fn().mockResolvedValue(undefined),
      markFailure: jest.fn().mockResolvedValue(false),
    };

    const service = new WebPushNotificationService(
      configService as any,
      webPushSubscriptionService as any,
    );

    return { service, webPushSubscriptionService };
  }

  it('exposes public config only when enabled with both VAPID keys', () => {
    expect(createService().service.getPublicConfig()).toEqual({
      enabled: true,
      publicKey: 'test-public-key',
    });

    expect(
      createService({ webPushVapidPrivateKey: '' }).service.getPublicConfig(),
    ).toEqual({ enabled: false, publicKey: null });

    expect(
      createService({ webPushVapidPublicKey: '' }).service.getPublicConfig(),
    ).toEqual({ enabled: false, publicKey: null });
  });

  it('skips dispatch as disabled when either VAPID key is missing', async () => {
    const { service, webPushSubscriptionService } = createService({
      webPushVapidPrivateKey: '',
    });

    (service as any).webPushClient = {
      setVapidDetails: jest.fn(),
      sendNotification: jest.fn(),
    };

    const summary = await service.sendNewNoticeBatch(
      {
        num: 101,
        subject: '테스트 법률안',
        proposerCategory: '정부',
        committee: '법제사법위원회',
        link: 'https://example.com/notice/101',
        contentId: null,
        attachments: { pdfFile: '', hwpFile: '' },
      } as any,
      [mockSubscription(1)],
    );

    expect(
      (service as any).webPushClient.sendNotification,
    ).not.toHaveBeenCalled();
    expect(webPushSubscriptionService.markSuccess).not.toHaveBeenCalled();
    expect(webPushSubscriptionService.markFailure).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      targetCount: 1,
      successCount: 0,
      failedCount: 0,
      deactivatedCount: 0,
    });
  });

  function mockSubscription(id: number): WebPushSubscription {
    return {
      id,
      endpoint: `https://push.example/subscription/${id}`,
      p256dh: `p256dh-${id}`,
      auth: `auth-${id}`,
      isActive: true,
    } as WebPushSubscription;
  }

  it('retries retryable failures (429) and succeeds without marking failure', async () => {
    const { service, webPushSubscriptionService } = createService();

    const sendNotification = jest
      .fn()
      .mockRejectedValueOnce({
        statusCode: 429,
        message: 'Too Many Requests',
        headers: { 'retry-after': '0' },
      })
      .mockResolvedValueOnce(undefined);

    (service as any).webPushClient = {
      setVapidDetails: jest.fn(),
      sendNotification,
    };

    const summary = await service.sendNewNoticeBatch(
      {
        num: 101,
        subject: '테스트 법률안',
        proposerCategory: '정부',
        committee: '법제사법위원회',
        link: 'https://example.com/notice/101',
        contentId: null,
        attachments: { pdfFile: '', hwpFile: '' },
      } as any,
      [mockSubscription(1)],
    );

    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(webPushSubscriptionService.markSuccess).toHaveBeenCalledTimes(1);
    expect(webPushSubscriptionService.markFailure).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      targetCount: 1,
      successCount: 1,
      failedCount: 0,
      deactivatedCount: 0,
    });
  });

  it('does not retry permanent failure (410) and marks subscription as deactivated', async () => {
    const { service, webPushSubscriptionService } = createService();
    webPushSubscriptionService.markFailure.mockResolvedValue(true);

    const goneError = Object.assign(new Error('Gone'), {
      statusCode: 410,
    });
    const sendNotification = jest.fn().mockRejectedValue(goneError);

    (service as any).webPushClient = {
      setVapidDetails: jest.fn(),
      sendNotification,
    };

    const summary = await service.sendChangeBatch(
      {
        noticeNum: 202,
        subject: '변경 테스트 법률안',
        eventType: 'updated' as any,
        changedFields: ['subject'],
        eventHash: 'hash-202',
      },
      [mockSubscription(2)],
    );

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(webPushSubscriptionService.markSuccess).not.toHaveBeenCalled();
    expect(webPushSubscriptionService.markFailure).toHaveBeenCalledWith(
      2,
      'Gone',
      { deactivate: true },
    );
    expect(summary).toMatchObject({
      targetCount: 1,
      successCount: 0,
      failedCount: 1,
      deactivatedCount: 1,
    });
  });

  it('removes a leading quote marker and truncates quoted opinion content', async () => {
    const { service } = createService();
    const sendNotification = jest.fn().mockResolvedValue(undefined);
    (service as any).webPushClient = {
      setVapidDetails: jest.fn(),
      sendNotification,
    };

    await service.sendQuoteBatch(
      {
        noticeNum: 303,
        threadId: 12,
        quotedSequence: 1,
        quotingSequence: 2,
        quotingCommentId: 8,
        quotingAuthorNickname: '인용자',
        quotingCommentContent: `>>#1\n${'본문 내용 '.repeat(80)}`,
      },
      [mockSubscription(3)],
    );

    const payload = JSON.parse(sendNotification.mock.calls[0][1]) as {
      body: string;
      url: string;
    };
    expect(payload.body).toContain('"본문 내용');
    expect(payload.body).not.toContain('" >>#1');
    expect(payload.body.length).toBeLessThan(260);
    expect(payload.body).toContain('…"');
    expect(payload.url).toBe(
      'http://localhost:5173/notices/303/discussions/12#res-2',
    );
  });
});
