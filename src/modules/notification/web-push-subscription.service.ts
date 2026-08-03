import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WebPushSubscription } from './web-push-subscription.entity';

export interface UpsertWebPushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}

@Injectable()
export class WebPushSubscriptionService {
  constructor(
    @InjectRepository(WebPushSubscription)
    private readonly subscriptionRepository: Repository<WebPushSubscription>,
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

  async findAllActive(): Promise<WebPushSubscription[]> {
    return this.subscriptionRepository.find({
      where: { isActive: true },
    });
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
