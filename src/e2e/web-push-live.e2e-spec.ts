import { Test, TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import appConfig from '../config/app.config';
import { WebPushSubscription } from '../modules/notification/web-push-subscription.entity';
import { WebPushSubscriptionService } from '../modules/notification/web-push-subscription.service';
import { WebPushNotificationService } from '../modules/notification/web-push-notification.service';

const runWebPushE2E = process.env.RUN_WEB_PUSH_E2E === 'true';
const webPushId = process.env.WEB_PUSH_SUBSCRIPTION_ID
  ? parseInt(process.env.WEB_PUSH_SUBSCRIPTION_ID, 10)
  : 1;
const webPushEndpoint =
  process.env.WEB_PUSH_SUBSCRIPTION_ENDPOINT?.trim() || '';
const itIfWebPush = runWebPushE2E ? it : it.skip;

describe('WebPushNotificationService (live e2e)', () => {
  let moduleRef: TestingModule;
  let configService: ConfigService;
  let subscriptionRepository: Repository<WebPushSubscription>;
  let webPushNotificationService: WebPushNotificationService;

  beforeAll(async () => {
    if (!runWebPushE2E) {
      return;
    }

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [appConfig],
          envFilePath: [
            '.env',
            '.env.local',
            '.env.development',
            '.env.production',
          ],
        }),
        TypeOrmModule.forRootAsync({
          inject: [ConfigService],
          useFactory: (cfg: ConfigService) => ({
            type: 'sqlite',
            database: cfg.get<string>('database.path'),
            entities: [WebPushSubscription],
            synchronize: false,
          }),
        }),
        TypeOrmModule.forFeature([WebPushSubscription]),
      ],
      providers: [WebPushSubscriptionService, WebPushNotificationService],
    }).compile();

    configService = moduleRef.get(ConfigService);
    subscriptionRepository = moduleRef.get<Repository<WebPushSubscription>>(
      getRepositoryToken(WebPushSubscription),
    );
    webPushNotificationService = moduleRef.get(WebPushNotificationService);
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  itIfWebPush(
    'sends a real test web push to the selected live subscription and validates successful delivery state',
    async () => {
      const enabled = configService.get<boolean>('webPush.enabled') === true;
      const publicKey = configService.get<string>('webPush.vapidPublicKey');
      const privateKey = configService.get<string>('webPush.vapidPrivateKey');

      expect(enabled).toBe(true);
      expect(publicKey).toBeTruthy();
      expect(privateKey).toBeTruthy();

      const target = webPushEndpoint
        ? await subscriptionRepository.findOne({
            where: { endpoint: webPushEndpoint },
          })
        : await subscriptionRepository.findOne({
            where: { id: webPushId },
          });
      expect(target).toBeTruthy();
      expect(target!.isActive).toBe(true);

      const beforeFailureCount = target!.failureCount ?? 0;
      const beforeLastNotifiedAt = target!.lastNotifiedAt
        ? new Date(target!.lastNotifiedAt).getTime()
        : null;

      await webPushNotificationService.sendNewNoticeBatch(
        {
          num: 1,
          subject: '[E2E] 웹 푸시 실전 전송 테스트',
          proposerCategory: '테스트',
          committee: '테스트',
          link: 'https://example.com/notices/1',
          contentId: null,
          attachments: { pdfFile: null, hwpFile: null },
        } as any,
        [target as WebPushSubscription],
      );

      const after = await subscriptionRepository.findOne({
        where: { id: webPushId },
      });
      expect(after).toBeTruthy();

      const afterFailureCount = after!.failureCount ?? 0;
      const afterLastNotifiedAt = after!.lastNotifiedAt
        ? new Date(after!.lastNotifiedAt).getTime()
        : null;

      expect(afterLastNotifiedAt).not.toBeNull();
      if (beforeLastNotifiedAt !== null) {
        expect(afterLastNotifiedAt!).toBeGreaterThanOrEqual(
          beforeLastNotifiedAt,
        );
      }
      expect(afterFailureCount).toBe(0);
      expect(after!.lastFailureReason).toBeNull();

      // Guard against false positives: failure count must not increase.
      expect(afterFailureCount).toBeLessThanOrEqual(beforeFailureCount);
    },
    30_000,
  );
});
