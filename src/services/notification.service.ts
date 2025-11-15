import { Injectable, Logger } from '@nestjs/common';
import {
  MessageBuilder,
  Webhook as DiscordWebhook,
} from 'discord-webhook-node';
import { type ITableData } from 'pal-crawl';
import { Webhook } from '../entities/webhook.entity';
import { APP_CONSTANTS } from '../config/app.config';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  async sendDiscordNotification(
    notice: ITableData,
    webhooks: Webhook[],
  ): Promise<void> {
    const embed = this.createNotificationEmbed(notice);

    for (const webhook of webhooks) {
      try {
        const discordWebhook = new DiscordWebhook(webhook.url);
        discordWebhook.setUsername('LawCast 알리미');

        await discordWebhook.send(embed);
      } catch (error) {
        this.logger.error(
          `Failed to send notification to webhook ${webhook.id}:`,
          error,
        );
      }
    }
  }

  /**
   * 병렬로 여러 웹훅에 알림을 전송하고 결과를 반환
   */
  async sendDiscordNotificationBatch(
    notice: ITableData,
    webhooks: Webhook[],
  ): Promise<Array<{ webhookId: number; success: boolean; error?: any }>> {
    const embed = this.createNotificationEmbed(notice);

    const promises = webhooks.map(async (webhook) => {
      try {
        const discordWebhook = new DiscordWebhook(webhook.url);
        discordWebhook.setUsername('LawCast 알리미');

        await discordWebhook.send(embed);
        return { webhookId: webhook.id, success: true };
      } catch (error) {
        this.logger.error(
          `Failed to send notification to webhook ${webhook.id}:`,
          error,
        );

        // Discord 웹훅 에러 상태를 확인하여 삭제 여부 결정
        const shouldDelete = this.shouldDeleteWebhook(error);

        return {
          webhookId: webhook.id,
          success: false,
          error: error,
          shouldDelete,
        };
      }
    });

    return Promise.all(promises);
  }

  /**
   * 알림 임베드 메시지를 생성
   */
  private createNotificationEmbed(notice: ITableData): MessageBuilder {
    return new MessageBuilder()
      .setTitle('🏦 새로운 국회 입법예고')
      .setDescription(
        '새로운 입법예고가 감지되었습니다. 아래 정보를 확인하세요.',
      )
      .addField('📋 법률안명', notice.subject, false)
      .addField('👥 제안자 구분', notice.proposerCategory, true)
      .addField('🏢 소관위원회', notice.committee, true)
      .addField('💬 의견 수', notice.numComments.toString(), true)
      .addField('🔗 자세히 보기', `[링크 바로가기](${notice.link})`, false)
      .setColor(APP_CONSTANTS.COLORS.DISCORD.PRIMARY)
      .setTimestamp()
      .setFooter('LawCast 알림 서비스', '');
  }

  /**
   * 웹훅 에러를 분석하여 삭제 여부를 결정
   */
  private shouldDeleteWebhook(error: any): boolean {
    // Discord API 에러 코드를 확인
    if (error.response?.status) {
      const status = error.response.status;
      const { NOT_FOUND, UNAUTHORIZED, FORBIDDEN } =
        APP_CONSTANTS.DISCORD.API.ERROR_CODES;

      // 404: 웹훅이 삭제됨, 401: 권한 없음, 403: 차단됨
      return [NOT_FOUND, UNAUTHORIZED, FORBIDDEN].includes(status);
    }

    // 네트워크 오류나 일시적 오류는 삭제하지 않음
    return false;
  }

  async testWebhook(
    webhookUrl: string,
  ): Promise<{ success: boolean; shouldDelete: boolean; error?: any }> {
    try {
      const discordWebhook = new DiscordWebhook(webhookUrl);
      discordWebhook.setUsername('LawCast 알리미');

      const testEmbed = new MessageBuilder()
        .setTitle('🧪 LawCast 웹훅 테스트')
        .setDescription('웹훅이 정상적으로 설정되었습니다!')
        .setColor(APP_CONSTANTS.COLORS.DISCORD.SUCCESS)
        .setTimestamp()
        .setFooter('LawCast 알림 서비스', '');

      await discordWebhook.send(testEmbed);
      return { success: true, shouldDelete: false };
    } catch (error) {
      this.logger.error('Failed to send test webhook notification:', error);
      return {
        success: false,
        shouldDelete: this.shouldDeleteWebhook(error),
        error,
      };
    }
  }
}
