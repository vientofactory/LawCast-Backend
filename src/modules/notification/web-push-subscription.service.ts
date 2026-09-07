import { Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';
import { DiscussionWebPushBinding } from './discussion-web-push-binding.entity';
import { WebPushSubscription } from './web-push-subscription.entity';

export interface UpsertWebPushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
  noticeNotificationsEnabled?: boolean;
}

export interface WebPushSubscriptionStats {
  total: number;
  active: number;
  inactive: number;
  withFailures: number;
}

@Injectable()
export class WebPushSubscriptionService {
  constructor(
    @InjectRepository(WebPushSubscription)
    private readonly subscriptionRepository: Repository<WebPushSubscription>,
    @InjectRepository(DiscussionWebPushBinding)
    @Optional()
    private readonly discussionBindingRepository?: Repository<DiscussionWebPushBinding>,
  ) {}

  async createOrReactivate(
    input: UpsertWebPushSubscriptionInput,
  ): Promise<WebPushSubscription> {
    const endpoint = input.endpoint.trim();
    const p256dh = input.p256dh.trim();
    const auth = input.auth.trim();
    const userAgent = input.userAgent?.trim() || null;

    const existing = await this.subscriptionRepository.findOne({
      where: { endpoint },
    });

    if (existing) {
      existing.p256dh = p256dh;
      existing.auth = auth;
      existing.userAgent = userAgent;
      existing.isActive = true;
      if (input.noticeNotificationsEnabled === true) {
        existing.noticeNotificationsEnabled = true;
      }
      existing.lastFailureReason = null;
      existing.failureCount = 0;
      return this.subscriptionRepository.save(existing);
    }

    const created = this.subscriptionRepository.create({
      endpoint,
      p256dh,
      auth,
      userAgent,
      isActive: true,
      noticeNotificationsEnabled: input.noticeNotificationsEnabled ?? true,
      failureCount: 0,
      lastFailureReason: null,
    });

    return this.subscriptionRepository.save(created);
  }

  async deactivateByEndpoint(endpoint: string): Promise<void> {
    const normalized = endpoint.trim();
    if (!normalized) return;

    const existing = await this.subscriptionRepository.findOne({
      where: { endpoint: normalized },
    });

    if (!existing) return;

    existing.isActive = false;
    await this.subscriptionRepository.save(existing);
  }

  async deleteByEndpoint(endpoint: string): Promise<void> {
    const normalized = endpoint.trim();
    if (!normalized) return;

    if (this.discussionBindingRepository) {
      const subscription = await this.subscriptionRepository.findOne({
        where: { endpoint: normalized },
      });
      if (subscription) {
        await this.discussionBindingRepository.delete({
          subscriptionId: subscription.id,
        });
      }
    }

    await this.subscriptionRepository.delete({ endpoint: normalized });
  }

  async findAllActive(): Promise<WebPushSubscription[]> {
    return this.subscriptionRepository.find({
      where: { isActive: true, noticeNotificationsEnabled: true },
    });
  }

  async getNoticeNotificationsEnabled(endpoint: string): Promise<boolean> {
    const subscription = await this.subscriptionRepository.findOne({
      where: { endpoint: endpoint.trim(), isActive: true },
    });
    return subscription?.noticeNotificationsEnabled === true;
  }

  async setNoticeNotificationsEnabled(
    endpoint: string,
    enabled: boolean,
  ): Promise<void> {
    const subscription = await this.subscriptionRepository.findOne({
      where: { endpoint: endpoint.trim() },
    });
    if (!subscription) return;

    subscription.noticeNotificationsEnabled = enabled;
    if (enabled) subscription.isActive = true;
    await this.subscriptionRepository.save(subscription);
  }

  async bindToDiscussion(
    subscriptionId: number,
    threadId: number,
    authorId: string,
  ): Promise<void> {
    if (!this.discussionBindingRepository) return;

    const existing = await this.discussionBindingRepository.findOne({
      where: { subscriptionId, threadId, authorId },
    });

    if (existing) {
      existing.isActive = true;
      await this.discussionBindingRepository.save(existing);
      return;
    }

    await this.discussionBindingRepository.save(
      this.discussionBindingRepository.create({
        subscriptionId,
        threadId,
        authorId,
        isActive: true,
      }),
    );
  }

  async findActiveForDiscussionAuthor(
    threadId: number,
    authorId: string,
  ): Promise<WebPushSubscription[]> {
    if (!this.discussionBindingRepository) return [];

    const bindings = await this.discussionBindingRepository.find({
      where: { threadId, authorId, isActive: true },
    });
    if (bindings.length === 0) return [];

    const subscriptions = await this.subscriptionRepository.findByIds(
      bindings.map((binding) => binding.subscriptionId),
    );
    const activeById = new Map(
      subscriptions
        .filter((subscription) => subscription.isActive)
        .map((subscription) => [subscription.id, subscription]),
    );
    return bindings
      .map((binding) => activeById.get(binding.subscriptionId))
      .filter((subscription): subscription is WebPushSubscription =>
        Boolean(subscription),
      );
  }

  async isEndpointBoundToDiscussion(
    endpoint: string,
    threadId: number,
    authorId: string,
  ): Promise<boolean> {
    if (!this.discussionBindingRepository) return false;

    const subscription = await this.subscriptionRepository.findOne({
      where: { endpoint: endpoint.trim(), isActive: true },
    });
    if (!subscription) return false;

    const binding = await this.discussionBindingRepository.findOne({
      where: {
        subscriptionId: subscription.id,
        threadId,
        authorId,
        isActive: true,
      },
    });
    return Boolean(binding);
  }

  async deactivateDiscussionBinding(
    endpoint: string,
    threadId: number,
    authorId: string,
  ): Promise<void> {
    if (!this.discussionBindingRepository) return;

    const subscription = await this.subscriptionRepository.findOne({
      where: { endpoint: endpoint.trim() },
    });
    if (!subscription) return;

    await this.discussionBindingRepository.update(
      { subscriptionId: subscription.id, threadId, authorId },
      { isActive: false },
    );
  }

  async getStatsForApi(): Promise<WebPushSubscriptionStats> {
    const [total, active, withFailures] = await Promise.all([
      this.subscriptionRepository.count(),
      this.subscriptionRepository.count({ where: { isActive: true } }),
      this.subscriptionRepository
        .createQueryBuilder('wps')
        .where('wps.failure_count > 0')
        .getCount(),
    ]);

    return {
      total,
      active,
      inactive: Math.max(0, total - active),
      withFailures,
    };
  }

  async markSuccess(subscriptionId: number): Promise<void> {
    await this.subscriptionRepository.update(subscriptionId, {
      failureCount: 0,
      lastFailureReason: null,
      lastNotifiedAt: new Date(),
      isActive: true,
    });
  }

  async markFailure(
    subscriptionId: number,
    reason: string,
    options: { deactivate?: boolean } = {},
  ): Promise<void> {
    const existing = await this.subscriptionRepository.findOne({
      where: { id: subscriptionId },
    });
    if (!existing) return;

    existing.failureCount = (existing.failureCount || 0) + 1;
    existing.lastFailureReason = reason.slice(0, 1000);
    if (options.deactivate === true) {
      existing.isActive = false;
    }

    await this.subscriptionRepository.save(existing);
  }

  /**
   * Deletes inactive subscriptions older than the given day threshold.
   * This is used by the monitoring cron to gradually clean stale endpoints.
   */
  async cleanupInactiveSubscriptions(daysBefore: number = 14): Promise<number> {
    const safeDays = Math.max(1, Math.trunc(daysBefore) || 14);
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - safeDays);

    if (this.discussionBindingRepository) {
      const staleSubscriptions = await this.subscriptionRepository.find({
        where: {
          isActive: false,
          updatedAt: LessThan(cutoffDate),
        },
      });
      const staleSubscriptionIds = staleSubscriptions.map(
        (subscription) => subscription.id,
      );

      if (staleSubscriptionIds.length > 0) {
        await this.discussionBindingRepository.delete({
          subscriptionId: In(staleSubscriptionIds),
        });
      }
    }

    const result = await this.subscriptionRepository
      .createQueryBuilder()
      .delete()
      .from(WebPushSubscription)
      .where('is_active = :isActive', { isActive: false })
      .andWhere('updated_at < :cutoffDate', { cutoffDate })
      .execute();

    return result.affected || 0;
  }
}
