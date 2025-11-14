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
    // 중복 URL 체크
    const existingWebhook = await this.webhookRepository.findOne({
      where: { url: webhookData.url },
    });

    if (existingWebhook) {
      throw new HttpException(
        'Webhook URL already exists',
        HttpStatus.CONFLICT,
      );
    }

    const webhook = this.webhookRepository.create({
      url: webhookData.url,
    });

    return this.webhookRepository.save(webhook);
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
