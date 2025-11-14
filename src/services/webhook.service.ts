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

  async create(webhookData: { url: string }): Promise<Webhook> {
    // URL 정규화
    const normalizedUrl = this.normalizeWebhookUrl(webhookData.url);

    // 중복 URL 체크 (정규화된 URL로)
    const existingWebhook = await this.webhookRepository.findOne({
      where: { url: normalizedUrl },
    });

    if (existingWebhook) {
      throw new HttpException(
        {
          success: false,
          message: '이미 등록된 웹훅 URL입니다.',
        },
        HttpStatus.CONFLICT,
      );
    }

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

  async remove(id: number): Promise<void> {
    const webhook = await this.findOne(id);
    webhook.isActive = false;
    await this.webhookRepository.save(webhook);
  }

  /**
   * 실패한 웹훅들을 배치로 비활성화
   */
  async removeFailedWebhooks(webhookIds: number[]): Promise<void> {
    if (webhookIds.length === 0) {
      return;
    }

    await this.webhookRepository.update(
      { id: In(webhookIds) },
      { isActive: false },
    );
  }

  /**
   * 통계 정보 조회
   */
  async getStats(): Promise<{
    total: number;
    active: number;
    inactive: number;
  }> {
    const [total, active] = await Promise.all([
      this.webhookRepository.count(),
      this.webhookRepository.count({ where: { isActive: true } }),
    ]);

    return {
      total,
      active,
      inactive: total - active,
    };
  }
}
