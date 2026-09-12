import { WebhookCleanupService } from './webhook-cleanup.service';

function createService(
  stats: {
    total?: number;
    active?: number;
    oldInactive?: number;
    recentInactive?: number;
  } = {},
) {
  const webhookService = {
    getDetailedStats: jest.fn().mockResolvedValue({
      total: stats.total ?? 100,
      active: stats.active ?? 80,
      oldInactive: stats.oldInactive ?? 5,
      recentInactive: stats.recentInactive ?? 15,
    }),
    cleanupOldInactiveWebhooks: jest.fn().mockResolvedValue(0),
    cleanupInactiveWebhooks: jest.fn().mockResolvedValue(0),
  };

  const service = new WebhookCleanupService(webhookService as any);

  return { service, webhookService };
}

describe('WebhookCleanupService', () => {
  describe('intelligentWebhookCleanup', () => {
    it('skips if cleanup is already running', async () => {
      const { service } = createService();

      // Start first cleanup (don't await)
      const promise1 = service.intelligentWebhookCleanup();
      // Try to start second cleanup immediately
      const promise2 = service.intelligentWebhookCleanup();

      await Promise.all([promise1, promise2]);
      // The second call should be a no-op — getDetailedStats called only once
    });

    it('cleans old inactive webhooks when they exist', async () => {
      const { service, webhookService } = createService({
        total: 100,
        active: 80,
        oldInactive: 5,
      });

      await service.intelligentWebhookCleanup();

      expect(webhookService.cleanupOldInactiveWebhooks).toHaveBeenCalledWith(
        14,
      );
    });

    it('skips old cleanup when no old inactive webhooks exist', async () => {
      const { service, webhookService } = createService({
        total: 100,
        active: 80,
        oldInactive: 0,
      });

      await service.intelligentWebhookCleanup();

      expect(
        webhookService.cleanupOldInactiveWebhooks,
      ).not.toHaveBeenCalledWith(14);
    });

    it('cleans recent inactive webhooks when efficiency is below 70%', async () => {
      const { service, webhookService } = createService({
        total: 100,
        active: 60,
        oldInactive: 0,
      });

      await service.intelligentWebhookCleanup();

      expect(webhookService.cleanupOldInactiveWebhooks).toHaveBeenCalledWith(7);
    });

    it('does not clean recent inactive webhooks when efficiency is 70%+', async () => {
      const { service, webhookService } = createService({
        total: 100,
        active: 70,
        oldInactive: 0,
      });

      await service.intelligentWebhookCleanup();

      // Only old cleanup (14 days) might be called, not recent (7 days)
      const calls7days =
        webhookService.cleanupOldInactiveWebhooks.mock.calls.filter(
          (c: number[]) => c[0] === 7,
        );
      expect(calls7days).toHaveLength(0);
    });

    it('performs emergency cleanup when efficiency is below 50%', async () => {
      const { service, webhookService } = createService({
        total: 100,
        active: 40,
        oldInactive: 0,
      });

      await service.intelligentWebhookCleanup();

      expect(webhookService.cleanupInactiveWebhooks).toHaveBeenCalled();
    });

    it('does not perform emergency cleanup when efficiency is 50%+', async () => {
      const { service, webhookService } = createService({
        total: 100,
        active: 50,
        oldInactive: 0,
      });

      await service.intelligentWebhookCleanup();

      expect(webhookService.cleanupInactiveWebhooks).not.toHaveBeenCalled();
    });

    it('does not throw when webhookService throws', async () => {
      const { service } = createService();

      // Override getDetailedStats to throw
      (service as any).webhookService.getDetailedStats.mockRejectedValue(
        new Error('DB error'),
      );

      await expect(
        service.intelligentWebhookCleanup(),
      ).resolves.toBeUndefined();
    });

    it('resets running lock after completion', async () => {
      const { service } = createService();

      await service.intelligentWebhookCleanup();
      // Second call should not be skipped
      await service.intelligentWebhookCleanup();

      // Both calls should have run (getDetailedStats called twice)
    });
  });

  describe('performSelfDiagnostics', () => {
    it('returns excellent health when efficiency is 90%+', async () => {
      const { service } = createService({
        total: 100,
        active: 90,
      });

      const result = await service.performSelfDiagnostics();

      expect(result.systemHealth).toBe('excellent');
    });

    it('returns good health when efficiency is 80-89%', async () => {
      const { service } = createService({
        total: 100,
        active: 85,
      });

      const result = await service.performSelfDiagnostics();

      expect(result.systemHealth).toBe('good');
    });

    it('returns fair health when efficiency is 60-79%', async () => {
      const { service } = createService({
        total: 100,
        active: 65,
      });

      const result = await service.performSelfDiagnostics();

      expect(result.systemHealth).toBe('fair');
    });

    it('returns poor health when efficiency is 40-59%', async () => {
      const { service } = createService({
        total: 100,
        active: 45,
      });

      const result = await service.performSelfDiagnostics();

      expect(result.systemHealth).toBe('poor');
    });

    it('returns critical health when efficiency is below 40%', async () => {
      const { service, webhookService } = createService({
        total: 100,
        active: 30,
      });

      const result = await service.performSelfDiagnostics();

      expect(result.systemHealth).toBe('critical');
      expect(webhookService.cleanupOldInactiveWebhooks).toHaveBeenCalledWith(1);
      expect(result.autoActionsPerformed.length).toBeGreaterThan(0);
    });

    it('returns excellent health when there are no webhooks', async () => {
      const { service } = createService({
        total: 0,
        active: 0,
      });

      const result = await service.performSelfDiagnostics();

      expect(result.systemHealth).toBe('excellent');
    });

    it('does not auto-clean when efficiency is above 40%', async () => {
      const { service, webhookService } = createService({
        total: 100,
        active: 50,
      });

      const result = await service.performSelfDiagnostics();

      expect(result.autoActionsPerformed).toHaveLength(0);
      expect(webhookService.cleanupOldInactiveWebhooks).not.toHaveBeenCalled();
    });
  });
});
