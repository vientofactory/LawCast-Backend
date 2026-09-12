import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { DiscussionThread } from '../discussions/entities/discussion-thread.entity';
import { IpMaskingUtil } from '../discussions/utils/ip-masking.util';
import { WebPushNotificationService } from './web-push-notification.service';
import { WebPushRegistrationService } from './web-push-registration.service';
import { WebPushSubscriptionService } from './web-push-subscription.service';

describe('WebPushRegistrationService', () => {
  beforeAll(() => {
    process.env.DISCUSSION_AUTHOR_ID_SECRET = 'test-author-id-secret';
  });

  function createService(options: { webPushEnabled: boolean }) {
    const hashguardService = {
      verifyProof: jest.fn().mockResolvedValue(true),
    };
    const webPushSubscriptionService = {
      createOrReactivate: jest.fn(),
      bindToDiscussion: jest.fn(),
      deleteByEndpoint: jest.fn(),
    } as unknown as jest.Mocked<WebPushSubscriptionService>;
    const webPushNotificationService = {
      isEnabled: jest.fn().mockReturnValue(options.webPushEnabled),
    } as unknown as jest.Mocked<WebPushNotificationService>;
    const discussionThreadRepository = {
      findOne: jest.fn(),
    } as unknown as Repository<DiscussionThread>;

    const service = new WebPushRegistrationService(
      hashguardService as any,
      webPushSubscriptionService,
      webPushNotificationService,
      discussionThreadRepository,
    );

    return {
      service,
      hashguardService,
      webPushSubscriptionService,
      discussionThreadRepository,
    };
  }

  it('rejects registration before PoW or persistence when web push is disabled', async () => {
    const { service, hashguardService, webPushSubscriptionService } =
      createService({ webPushEnabled: false });

    await expect(
      service.registerSubscription(
        {
          endpoint: 'https://push.example/subscription/1',
          p256dh: 'p256dh',
          auth: 'auth',
          proof: 'proof',
        },
        { headers: {}, ip: '127.0.0.1' } as any,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(hashguardService.verifyProof).not.toHaveBeenCalled();
    expect(
      webPushSubscriptionService.createOrReactivate,
    ).not.toHaveBeenCalled();
  });

  it('derives the discussion authorId from the proxy-forwarded client IP, not the raw socket IP', async () => {
    const { service, webPushSubscriptionService, discussionThreadRepository } =
      createService({ webPushEnabled: true });
    (discussionThreadRepository.findOne as jest.Mock).mockResolvedValue({
      id: 42,
    });
    (
      webPushSubscriptionService.createOrReactivate as jest.Mock
    ).mockResolvedValue({ id: 7 });

    const realClientIp = '203.0.113.10';
    await service.registerSubscription(
      {
        endpoint: 'https://push.example/subscription/1',
        p256dh: 'p256dh',
        auth: 'auth',
        proof: 'proof',
        threadId: 42,
      },
      {
        headers: { 'cf-connecting-ip': realClientIp },
        ip: '10.0.0.5', // reverse proxy's socket IP, must not be used
      } as any,
    );

    const expectedAuthorId = IpMaskingUtil.authorIdFromIp(
      realClientIp,
      'thread:42',
    );
    expect(webPushSubscriptionService.bindToDiscussion).toHaveBeenCalledWith(
      7,
      42,
      expectedAuthorId,
    );
  });

  it('rejects registration with a 400 when the client IP cannot be extracted', async () => {
    const { service, hashguardService, webPushSubscriptionService } =
      createService({ webPushEnabled: true });

    await expect(
      service.registerSubscription(
        {
          endpoint: 'https://push.example/subscription/1',
          p256dh: 'p256dh',
          auth: 'auth',
          proof: 'proof',
        },
        { headers: {} } as any,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(hashguardService.verifyProof).not.toHaveBeenCalled();
    expect(
      webPushSubscriptionService.createOrReactivate,
    ).not.toHaveBeenCalled();
  });

  it('rejects registration when proof-of-work verification fails', async () => {
    const { service, hashguardService, webPushSubscriptionService } =
      createService({ webPushEnabled: true });
    hashguardService.verifyProof.mockResolvedValue(false);

    await expect(
      service.registerSubscription(
        {
          endpoint: 'https://push.example/subscription/1',
          p256dh: 'p256dh',
          auth: 'auth',
          proof: 'invalid-proof',
        },
        { headers: {}, ip: '127.0.0.1' } as any,
      ),
    ).rejects.toMatchObject({ status: 400 });

    expect(
      webPushSubscriptionService.createOrReactivate,
    ).not.toHaveBeenCalled();
  });

  it('rejects registration with a non-existent threadId', async () => {
    const { service, discussionThreadRepository, webPushSubscriptionService } =
      createService({ webPushEnabled: true });
    (discussionThreadRepository.findOne as jest.Mock).mockResolvedValue(null);

    await expect(
      service.registerSubscription(
        {
          endpoint: 'https://push.example/subscription/1',
          p256dh: 'p256dh',
          auth: 'auth',
          proof: 'proof',
          threadId: 99999,
        },
        { headers: {}, ip: '127.0.0.1' } as any,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(
      webPushSubscriptionService.createOrReactivate,
    ).not.toHaveBeenCalled();
  });

  it('skips discussion binding when threadId is omitted', async () => {
    const { service, webPushSubscriptionService } = createService({
      webPushEnabled: true,
    });
    (
      webPushSubscriptionService.createOrReactivate as jest.Mock
    ).mockResolvedValue({ id: 7 });

    await service.registerSubscription(
      {
        endpoint: 'https://push.example/subscription/1',
        p256dh: 'p256dh',
        auth: 'auth',
        proof: 'proof',
      },
      { headers: {}, ip: '127.0.0.1' } as any,
    );

    expect(webPushSubscriptionService.createOrReactivate).toHaveBeenCalledWith(
      expect.objectContaining({
        noticeNotificationsEnabled: true,
      }),
    );
    expect(webPushSubscriptionService.bindToDiscussion).not.toHaveBeenCalled();
  });
});
