import { ServiceUnavailableException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { DiscussionThread } from '../discussions/entities/discussion-thread.entity';
import { WebPushNotificationService } from './web-push-notification.service';
import { WebPushRegistrationService } from './web-push-registration.service';
import { WebPushSubscriptionService } from './web-push-subscription.service';

describe('WebPushRegistrationService', () => {
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

    return { service, hashguardService, webPushSubscriptionService };
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
});
