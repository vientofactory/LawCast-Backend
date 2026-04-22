import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Webhook } from '../entities/webhook.entity';

@Injectable()
export class WebhookService {
  constructor(
    @InjectRepository(Webhook)
    private webhookRepository: Repository<Webhook>,
  ) {}

  /**
   * Create a new webhook or reactivate an existing one if it was soft-deleted
   * @param url - The URL of the webhook to create or reactivate
   * @returns The created or reactivated Webhook entity
   */
  async create(url: string): Promise<Webhook> {
    const normalizedUrl = this.normalizeWebhookUrl(url);

    const existingWebhook = await this.webhookRepository.findOne({
      where: { url: normalizedUrl },
    });

    if (existingWebhook) {
      if (!existingWebhook.isActive) {
        existingWebhook.isActive = true;
        existingWebhook.updatedAt = new Date();
        return this.webhookRepository.save(existingWebhook);
      }
      return existingWebhook;
    }

    const webhook = this.webhookRepository.create({
      url: normalizedUrl,
    });

    return this.webhookRepository.save(webhook);
  }

  /**
   * Normalize webhook URLs to ensure consistent storage and comparison, removing query parameters and trailing slashes
   * @param url - The URL to normalize
   * @returns The normalized URL string
   */
  private normalizeWebhookUrl(url: string): string {
    try {
      const parsed = new URL(url);
      parsed.search = '';
      parsed.hash = '';

      let normalizedPath = parsed.pathname;
      if (normalizedPath.endsWith('/') && normalizedPath.length > 1) {
        normalizedPath = normalizedPath.slice(0, -1);
      }

      return `${parsed.protocol}//${parsed.host}${normalizedPath}`;
    } catch {
      // Fallback to original URL if parsing fails
      return url;
    }
  }

  // Utility methods for managing webhooks

  async findAll(): Promise<Webhook[]> {
    return this.webhookRepository.find({
      where: { isActive: true },
    });
  }

  async findOne(id: number): Promise<Webhook> {
    const webhook = await this.webhookRepository.findOne({ where: { id } });
    if (!webhook) {
      throw new HttpException('Webhook not found', HttpStatus.NOT_FOUND);
    }
    return webhook;
  }

  async findByUrl(url: string): Promise<Webhook | null> {
    const normalizedUrl = this.normalizeWebhookUrl(url);
    return this.webhookRepository.findOne({
      where: { url: normalizedUrl, isActive: true },
    });
  }

  async remove(id: number): Promise<void> {
    const webhook = await this.findOne(id);
    webhook.isActive = false;
    await this.webhookRepository.save(webhook);
  }

  /**
   * Remove failed webhooks in batches for efficient cleanup
   * @param webhookIds - Array of webhook IDs to remove
   * @returns The number of webhooks removed
   */
  async removeFailedWebhooks(webhookIds: number[]): Promise<number> {
    if (webhookIds.length === 0) {
      return 0;
    }

    const batchSize = 500;
    let totalDeleted = 0;

    for (let i = 0; i < webhookIds.length; i += batchSize) {
      const batch = webhookIds.slice(i, i + batchSize);
      const result = await this.webhookRepository.delete({ id: In(batch) });
      totalDeleted += result.affected || 0;
    }

    return totalDeleted;
  }

  /**
   * Create or reactivate multiple webhooks in bulk, ensuring efficient handling of duplicates and reactivations
   * @param urls - Array of webhook URLs to create or reactivate
   * @returns An object containing counts of created, reactivated, and duplicate webhooks
   */
  async createBulk(
    urls: string[],
  ): Promise<{ created: number; reactivated: number; duplicates: number }> {
    const normalizedUrls = urls.map((url) => this.normalizeWebhookUrl(url));
    const uniqueUrls = [...new Set(normalizedUrls)];

    let created = 0;
    let reactivated = 0;
    const duplicates = urls.length - uniqueUrls.length;

    for (const url of uniqueUrls) {
      const existing = await this.webhookRepository.findOne({ where: { url } });

      if (existing) {
        if (!existing.isActive) {
          existing.isActive = true;
          existing.updatedAt = new Date();
          await this.webhookRepository.save(existing);
          reactivated++;
        }
      } else {
        const webhook = this.webhookRepository.create({ url });
        await this.webhookRepository.save(webhook);
        created++;
      }
    }

    return { created, reactivated, duplicates };
  }

  /**
   * Clean up all inactive webhooks immediately, typically used in emergency situations to restore system efficiency
   * @returns The number of webhooks removed
   */
  async cleanupInactiveWebhooks(): Promise<number> {
    const result = await this.webhookRepository.delete({ isActive: false });
    return result.affected || 0;
  }

  /**
   * Clean up old inactive webhooks in batches for efficient maintenance
   * @param daysBefore - Number of days before which inactive webhooks are considered old
   * @returns The number of webhooks removed
   */
  async cleanupOldInactiveWebhooks(daysBefore: number = 30): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysBefore);

    const batchSize = 1000;
    let totalDeleted = 0;
    let hasMore = true;

    while (hasMore) {
      const webhooksToDelete = await this.webhookRepository
        .createQueryBuilder('webhook')
        .select('webhook.id')
        .where('webhook.isActive = :isActive', { isActive: false })
        .andWhere('webhook.updatedAt < :cutoffDate', { cutoffDate })
        .limit(batchSize)
        .getMany();

      if (webhooksToDelete.length === 0) {
        break;
      }

      const ids = webhooksToDelete.map((w) => w.id);
      const result = await this.webhookRepository.delete({ id: In(ids) });

      const deleted = result.affected || 0;
      totalDeleted += deleted;
      hasMore = webhooksToDelete.length === batchSize;
    }

    return totalDeleted;
  }

  /**
   * Get detailed statistics about webhooks for intelligent cleanup decisions
   * @returns An object containing total, active, inactive, oldInactive, recentInactive counts and efficiency percentage
   */
  async getDetailedStats(): Promise<{
    total: number;
    active: number;
    inactive: number;
    oldInactive: number;
    recentInactive: number;
    efficiency: number;
  }> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 30);

    const recentCutoffDate = new Date();
    recentCutoffDate.setDate(recentCutoffDate.getDate() - 7);

    // Collect all statistics in a single query for performance optimization
    const result = await this.webhookRepository
      .createQueryBuilder('webhook')
      .select([
        'COUNT(*) as total',
        'SUM(CASE WHEN webhook.isActive = true THEN 1 ELSE 0 END) as active',
        'SUM(CASE WHEN webhook.isActive = false THEN 1 ELSE 0 END) as inactive',
        'SUM(CASE WHEN webhook.isActive = false AND webhook.updatedAt < :cutoffDate THEN 1 ELSE 0 END) as oldInactive',
        'SUM(CASE WHEN webhook.isActive = false AND webhook.updatedAt > :recentCutoffDate THEN 1 ELSE 0 END) as recentInactive',
      ])
      .setParameters({ cutoffDate, recentCutoffDate })
      .getRawOne();

    const stats = {
      total: parseInt(result.total) || 0,
      active: parseInt(result.active) || 0,
      inactive: parseInt(result.inactive) || 0,
      oldInactive: parseInt(result.oldInactive) || 0,
      recentInactive: parseInt(result.recentInactive) || 0,
      efficiency: 0,
    };

    stats.efficiency =
      stats.total > 0 ? (stats.active / stats.total) * 100 : 100;

    return stats;
  }
}
