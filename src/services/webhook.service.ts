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

  async create(url: string): Promise<Webhook> {
    const normalizedUrl = this.normalizeWebhookUrl(url);

    // 중복 확인 및 soft delete된 웹훅 복원
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

    // 새로운 웹훅 생성
    const webhook = this.webhookRepository.create({
      url: normalizedUrl,
    });

    return this.webhookRepository.save(webhook);
  }

  private normalizeWebhookUrl(url: string): string {
    // URL 끝의 슬래시 제거 및 쿼리 파라미터 정리
    try {
      const parsed = new URL(url);
      // 쿼리 파라미터 제거 (웹훅 URL에는 불필요)
      parsed.search = '';
      parsed.hash = '';

      let normalizedPath = parsed.pathname;
      // 끝의 슬래시 제거
      if (normalizedPath.endsWith('/') && normalizedPath.length > 1) {
        normalizedPath = normalizedPath.slice(0, -1);
      }

      return `${parsed.protocol}//${parsed.host}${normalizedPath}`;
    } catch {
      return url; // 파싱 실패 시 원본 반환
    }
  }

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
   * 실패한 웹훅들을 배치로 효율적 삭제
   */
  async removeFailedWebhooks(webhookIds: number[]): Promise<number> {
    if (webhookIds.length === 0) {
      return 0;
    }

    // 배치 크기 제한으로 대용량 삭제 시 성능 보장
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
   * 대량 웹훅 생성 (중복 제거 및 최적화)
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
   * 비활성 웹훅들을 완전히 정리 (DB 최적화용)
   */
  async cleanupInactiveWebhooks(): Promise<number> {
    const result = await this.webhookRepository.delete({ isActive: false });
    return result.affected || 0;
  }

  /**
   * 오래된 비활성 웹훅들을 배치로 효율적 정리
   */
  async cleanupOldInactiveWebhooks(daysBefore: number = 30): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysBefore);

    // 배치 처리를 위해 ID 기반으로 처리
    const batchSize = 1000;
    let totalDeleted = 0;
    let hasMore = true;

    while (hasMore) {
      // 삭제할 ID들을 먼저 조회
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

      // 조회된 ID들로 삭제 실행
      const ids = webhooksToDelete.map((w) => w.id);
      const result = await this.webhookRepository.delete({ id: In(ids) });

      const deleted = result.affected || 0;
      totalDeleted += deleted;
      hasMore = webhooksToDelete.length === batchSize;
    }

    return totalDeleted;
  }

  /**
   * 최적화된 통계 조회 (단일 쿼리로 모든 정보 수집)
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

    // 단일 쿼리로 모든 통계 수집 (성능 최적화)
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
