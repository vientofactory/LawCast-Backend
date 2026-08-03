import { Repository } from 'typeorm';
import { WebPushSubscriptionService } from './web-push-subscription.service';
import { WebPushSubscription } from './web-push-subscription.entity';

describe('WebPushSubscriptionService', () => {
  describe('deleteByEndpoint', () => {
    it('should delete subscription by normalized endpoint', async () => {
      const deleteMock = jest.fn().mockResolvedValue({ affected: 1 });
      const repository = {
        delete: deleteMock,
      } as unknown as Repository<WebPushSubscription>;

      const service = new WebPushSubscriptionService(repository);
      await service.deleteByEndpoint('  https://push.example/sub/1  ');

      expect(deleteMock).toHaveBeenCalledTimes(1);
      expect(deleteMock).toHaveBeenCalledWith({
        endpoint: 'https://push.example/sub/1',
      });
    });

    it('should no-op for empty endpoint', async () => {
      const deleteMock = jest.fn();
      const repository = {
        delete: deleteMock,
      } as unknown as Repository<WebPushSubscription>;

      const service = new WebPushSubscriptionService(repository);
      await service.deleteByEndpoint('   ');

      expect(deleteMock).not.toHaveBeenCalled();
    });
  });

  describe('cleanupInactiveSubscriptions', () => {
    it('should delete only inactive subscriptions older than cutoff and return affected count', async () => {
      const execute = jest.fn().mockResolvedValue({ affected: 3 });
      const andWhere = jest.fn().mockReturnValue({ execute });
      const where = jest.fn().mockReturnValue({ andWhere });
      const from = jest.fn().mockReturnValue({ where });
      const deleteFn = jest.fn().mockReturnValue({ from });
      const createQueryBuilder = jest.fn().mockReturnValue({
        delete: deleteFn,
      });

      const repository = {
        createQueryBuilder,
      } as unknown as Repository<WebPushSubscription>;

      const service = new WebPushSubscriptionService(repository);
      const removed = await service.cleanupInactiveSubscriptions(14);

      expect(removed).toBe(3);
      expect(createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(deleteFn).toHaveBeenCalledTimes(1);
      expect(from).toHaveBeenCalledWith(WebPushSubscription);
      expect(where).toHaveBeenCalledWith('is_active = :isActive', {
        isActive: false,
      });
      expect(andWhere).toHaveBeenCalledWith('updated_at < :cutoffDate', {
        cutoffDate: expect.any(Date),
      });
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('should normalize invalid retention input to at least one day', async () => {
      const execute = jest.fn().mockResolvedValue({ affected: 0 });
      const andWhere = jest.fn().mockReturnValue({ execute });
      const where = jest.fn().mockReturnValue({ andWhere });
      const from = jest.fn().mockReturnValue({ where });
      const deleteFn = jest.fn().mockReturnValue({ from });
      const createQueryBuilder = jest.fn().mockReturnValue({
        delete: deleteFn,
      });

      const repository = {
        createQueryBuilder,
      } as unknown as Repository<WebPushSubscription>;

      const service = new WebPushSubscriptionService(repository);
      await service.cleanupInactiveSubscriptions(0);

      expect(andWhere).toHaveBeenCalledWith('updated_at < :cutoffDate', {
        cutoffDate: expect.any(Date),
      });
    });
  });
});
