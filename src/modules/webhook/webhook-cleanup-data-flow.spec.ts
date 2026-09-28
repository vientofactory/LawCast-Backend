import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Webhook } from './webhook.entity';
import { WebhookService } from './webhook.service';
import { WebhookCleanupService } from './webhook-cleanup.service';

/**
 * Exercises the real deletion-marking -> cleanup-cron data flow against a real
 * sqlite database (no repository mocks), so the SQL conditions used by the
 * cleanup path are verified against the columns the marking write points
 * actually persist. The webhooks table keeps camelCase column names (see
 * migrations/202604170001-initial-schema.migration.ts).
 */
describe('Webhook cleanup data flow (real sqlite)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let webhookService: WebhookService;
  let webhookCleanupService: WebhookCleanupService;

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
        TypeOrmModule.forFeature([Webhook]),
      ],
      providers: [WebhookService, WebhookCleanupService],
    }).compile();

    dataSource = moduleRef.get(DataSource);
    webhookService = moduleRef.get(WebhookService);
    webhookCleanupService = moduleRef.get(WebhookCleanupService);
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  /**
   * Rewrites updatedAt with the same UTC datetime string format TypeORM's
   * sqlite driver persists and binds for raw query comparisons, so backdating
   * behaves exactly like a row that aged naturally.
   */
  async function backdateUpdatedAt(id: number, daysAgo: number): Promise<void> {
    const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    const timestamp = date.toISOString().replace('T', ' ').replace('Z', '');
    await dataSource.query('UPDATE webhooks SET updatedAt = ? WHERE id = ?', [
      timestamp,
      id,
    ]);
  }

  it('collects deletion-marked webhooks through the cleanup path once past retention', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 10; i++) {
      const webhook = await webhookService.create(
        `https://discord.com/api/webhooks/${1000 + i}/token${i}`,
      );
      ids.push(webhook.id);
    }

    // Deletion-marking write point used by notification-batch dispatch
    // failure handling (permanent Discord failures).
    await webhookService.remove(ids[0]);

    // Within the 14-day retention window the marked row must survive.
    await backdateUpdatedAt(ids[0], 5);
    await webhookCleanupService.intelligentWebhookCleanup();
    let marked = await dataSource
      .getRepository(Webhook)
      .findOne({ where: { id: ids[0] } });
    expect(marked).toBeTruthy();
    expect(marked!.isActive).toBe(false);

    // Past retention it must be collected even though overall efficiency is
    // high (90%) and getDetailedStats' 30-day oldInactive counter does not
    // count a 20-day-old row yet.
    await backdateUpdatedAt(ids[0], 20);
    await webhookCleanupService.intelligentWebhookCleanup();
    marked = await dataSource
      .getRepository(Webhook)
      .findOne({ where: { id: ids[0] } });
    expect(marked).toBeNull();

    // Active webhooks are untouched.
    const remaining = await dataSource.getRepository(Webhook).count();
    expect(remaining).toBe(9);
  });
});
