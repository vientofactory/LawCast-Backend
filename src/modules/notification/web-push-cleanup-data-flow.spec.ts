import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { WebPushSubscription } from './web-push-subscription.entity';
import { DiscussionWebPushBinding } from './discussion-web-push-binding.entity';
import { WebPushSubscriptionService } from './web-push-subscription.service';

/**
 * Exercises the real deletion-marking -> cleanup-cron data flow against a real
 * sqlite database (no repository mocks): 404/410-invalidated subscriptions are
 * collected with their bindings after retention, while subscriptions that only
 * failed transiently (429/5xx/network) stay retryable and are never deleted.
 */
describe('Web push subscription cleanup data flow (real sqlite)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let webPushSubscriptionService: WebPushSubscriptionService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'sqlite',
          database: ':memory:',
          autoLoadEntities: true,
          synchronize: true,
          dropSchema: true,
        }),
        TypeOrmModule.forFeature([
          WebPushSubscription,
          DiscussionWebPushBinding,
        ]),
      ],
      providers: [WebPushSubscriptionService],
    }).compile();

    dataSource = moduleRef.get(DataSource);
    webPushSubscriptionService = moduleRef.get(WebPushSubscriptionService);
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  /**
   * Rewrites updated_at with the same UTC datetime string format TypeORM's
   * sqlite driver persists and binds for raw query comparisons, so backdating
   * behaves exactly like a row that aged naturally.
   */
  async function backdateUpdatedAt(id: number, daysAgo: number): Promise<void> {
    const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    const timestamp = date.toISOString().replace('T', ' ').replace('Z', '');
    await dataSource.query(
      'UPDATE web_push_subscriptions SET updated_at = ? WHERE id = ?',
      [timestamp, id],
    );
  }

  it('collects 404/410-invalidated subscriptions with their bindings after retention', async () => {
    const gone = await webPushSubscriptionService.createOrReactivate({
      endpoint: 'https://push.example/subscription/gone',
      p256dh: 'p256dh-key',
      auth: 'auth-key',
    });
    const keep = await webPushSubscriptionService.createOrReactivate({
      endpoint: 'https://push.example/subscription/keep',
      p256dh: 'p256dh-key',
      auth: 'auth-key',
    });
    await webPushSubscriptionService.bindToDiscussion(gone.id, 42, 'author-1');

    // 404/410 write point: the push service reports the subscription invalid.
    const deactivated = await webPushSubscriptionService.markFailure(
      gone.id,
      'Gone',
      { deactivate: true },
    );
    expect(deactivated).toBe(true);

    // Within retention: nothing is collected and bindings stay intact.
    await backdateUpdatedAt(gone.id, 5);
    const removedEarly =
      await webPushSubscriptionService.cleanupInactiveSubscriptions(14);
    expect(removedEarly).toBe(0);
    expect(
      await dataSource
        .getRepository(DiscussionWebPushBinding)
        .count({ where: { subscriptionId: gone.id } }),
    ).toBe(1);

    // Past retention: the invalidated subscription and its bindings are gone,
    // while the healthy subscription remains.
    await backdateUpdatedAt(gone.id, 20);
    const removed =
      await webPushSubscriptionService.cleanupInactiveSubscriptions(14);
    expect(removed).toBe(1);
    expect(
      await dataSource
        .getRepository(WebPushSubscription)
        .findOne({ where: { id: gone.id } }),
    ).toBeNull();
    expect(
      await dataSource
        .getRepository(DiscussionWebPushBinding)
        .count({ where: { subscriptionId: gone.id } }),
    ).toBe(0);
    expect(
      await dataSource
        .getRepository(WebPushSubscription)
        .findOne({ where: { id: keep.id } }),
    ).toBeTruthy();
  });

  it('never collects subscriptions that only failed transiently (429/5xx stay retryable)', async () => {
    const transient = await webPushSubscriptionService.createOrReactivate({
      endpoint: 'https://push.example/subscription/transient',
      p256dh: 'p256dh-key',
      auth: 'auth-key',
    });
    await webPushSubscriptionService.bindToDiscussion(
      transient.id,
      77,
      'author-2',
    );

    // Repeated transient failures (429/5xx/network) must not invalidate the
    // subscription per the web push specs; only 404/410 may.
    for (let i = 0; i < 5; i++) {
      const deactivated = await webPushSubscriptionService.markFailure(
        transient.id,
        'Service Unavailable',
      );
      expect(deactivated).toBe(false);
    }

    const row = await dataSource
      .getRepository(WebPushSubscription)
      .findOne({ where: { id: transient.id } });
    expect(row!.isActive).toBe(true);
    expect(row!.failureCount).toBe(5);

    // Even well past any retention window, an active subscription with only
    // transient failures is never a cleanup target.
    await backdateUpdatedAt(transient.id, 20);
    const removed =
      await webPushSubscriptionService.cleanupInactiveSubscriptions(14);
    expect(removed).toBe(0);
    expect(
      await dataSource
        .getRepository(WebPushSubscription)
        .findOne({ where: { id: transient.id } }),
    ).toBeTruthy();
    expect(
      await dataSource
        .getRepository(DiscussionWebPushBinding)
        .count({ where: { subscriptionId: transient.id } }),
    ).toBe(1);
  });
});
