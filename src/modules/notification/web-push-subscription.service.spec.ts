import { Repository } from 'typeorm';
import { WebPushSubscriptionService } from './web-push-subscription.service';
import { WebPushSubscription } from './web-push-subscription.entity';
import { DiscussionWebPushBinding } from './discussion-web-push-binding.entity';

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

    it('removes every discussion binding before deleting one endpoint subscription', async () => {
      const subscriptionRepository = {
        findOne: jest.fn().mockResolvedValue({ id: 9 }),
        delete: jest.fn().mockResolvedValue({ affected: 1 }),
      } as unknown as Repository<WebPushSubscription>;
      const bindingRepository = {
        delete: jest.fn().mockResolvedValue({ affected: 3 }),
      } as unknown as Repository<DiscussionWebPushBinding>;

      const service = new WebPushSubscriptionService(
        subscriptionRepository,
        bindingRepository,
      );
      await service.deleteByEndpoint('https://push.example/sub/1');

      expect(bindingRepository.delete).toHaveBeenCalledWith({
        subscriptionId: 9,
      });
      expect(subscriptionRepository.delete).toHaveBeenCalledWith({
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
    it('removes bindings for all stale subscriptions before cleanup', async () => {
      const subscriptionRepository = {
        find: jest.fn().mockResolvedValue([{ id: 9 }, { id: 10 }]),
        createQueryBuilder: jest.fn().mockReturnValue({
          delete: jest.fn().mockReturnValue({
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                execute: jest.fn().mockResolvedValue({ affected: 2 }),
              }),
            }),
          }),
        }),
      } as unknown as Repository<WebPushSubscription>;
      const bindingRepository = {
        delete: jest.fn().mockResolvedValue({ affected: 2 }),
      } as unknown as Repository<DiscussionWebPushBinding>;

      const service = new WebPushSubscriptionService(
        subscriptionRepository,
        bindingRepository,
      );
      await service.cleanupInactiveSubscriptions(14);

      expect(bindingRepository.delete).toHaveBeenCalledWith({
        subscriptionId: expect.objectContaining({
          _type: 'in',
          _value: [9, 10],
        }),
      });
    });

    it('should delete only inactive subscriptions older than cutoff and return affected count', async () => {
      const execute = jest.fn().mockResolvedValue({ affected: 3 });
      const where = jest.fn().mockReturnValue({ execute });
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
      expect(where).toHaveBeenCalledWith(
        '(is_active = :isActive AND updated_at < :cutoffDate) OR failure_count >= :failureThreshold',
        {
          isActive: false,
          cutoffDate: expect.any(Date),
          failureThreshold: service.webPushFailureDeactivationThreshold,
        },
      );
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('should normalize invalid retention input to at least one day', async () => {
      const execute = jest.fn().mockResolvedValue({ affected: 0 });
      const where = jest.fn().mockReturnValue({ execute });
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

      expect(where).toHaveBeenCalledWith(
        '(is_active = :isActive AND updated_at < :cutoffDate) OR failure_count >= :failureThreshold',
        {
          isActive: false,
          cutoffDate: expect.any(Date),
          failureThreshold: service.webPushFailureDeactivationThreshold,
        },
      );
    });
  });

  describe('markFailure', () => {
    it('deactivates a subscription after repeated delivery failures', async () => {
      const save = jest.fn();
      const findOne = jest.fn();
      const repository = {
        findOne,
        save,
      } as unknown as Repository<WebPushSubscription>;
      const service = new WebPushSubscriptionService(repository);
      const subscription = {
        id: 12,
        failureCount: service.webPushFailureDeactivationThreshold - 1,
        isActive: true,
      } as WebPushSubscription;
      findOne.mockResolvedValue(subscription);
      save.mockResolvedValue(subscription);
      const deactivated = await service.markFailure(12, 'Push service failed');

      expect(deactivated).toBe(true);
      expect(subscription.failureCount).toBe(
        service.webPushFailureDeactivationThreshold,
      );
      expect(subscription.isActive).toBe(false);
      expect(save).toHaveBeenCalledWith(subscription);
    });
  });

  describe('deleteBindingsForThreadIds', () => {
    it('deletes bindings matching any of the given thread ids', async () => {
      const bindingRepository = {
        delete: jest.fn().mockResolvedValue({ affected: 4 }),
      } as unknown as Repository<DiscussionWebPushBinding>;
      const subscriptionRepository =
        {} as unknown as Repository<WebPushSubscription>;

      const service = new WebPushSubscriptionService(
        subscriptionRepository,
        bindingRepository,
      );
      const removed = await service.deleteBindingsForThreadIds([1, 2, 3]);

      expect(removed).toBe(4);
      expect(bindingRepository.delete).toHaveBeenCalledWith({
        threadId: expect.objectContaining({ _type: 'in', _value: [1, 2, 3] }),
      });
    });

    it('no-ops when there are no thread ids', async () => {
      const bindingRepository = {
        delete: jest.fn(),
      } as unknown as Repository<DiscussionWebPushBinding>;
      const subscriptionRepository =
        {} as unknown as Repository<WebPushSubscription>;

      const service = new WebPushSubscriptionService(
        subscriptionRepository,
        bindingRepository,
      );
      const removed = await service.deleteBindingsForThreadIds([]);

      expect(removed).toBe(0);
      expect(bindingRepository.delete).not.toHaveBeenCalled();
    });
  });
});
