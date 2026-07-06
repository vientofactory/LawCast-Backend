import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { randomUUID } from 'crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Interaction,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { LoggerUtils } from '../../utils/logger.utils';
import { NotificationService } from '../notification/notification.service';
import { WebhookService } from '../webhook/webhook.service';

@Injectable()
export class DiscordBridgeAdminAnnouncementCommandService {
  private readonly logger = LoggerUtils.getContextLogger(
    DiscordBridgeAdminAnnouncementCommandService.name,
  );
  private readonly ANNOUNCEMENT_PREFIX = 'admin_announcement';
  private readonly ANNOUNCEMENT_TTL_MS = 10 * 60 * 1000;
  private readonly ANNOUNCEMENT_TITLE_MAX_LENGTH = 120;
  private readonly ANNOUNCEMENT_BODY_MAX_LENGTH = 4000;
  private readonly ANNOUNCEMENT_BODY_MIN_LENGTH = 10;
  private readonly ANNOUNCEMENT_CONFIRM_KEYWORD = 'SEND';

  private readonly pendingAnnouncements = new Map<
    string,
    PendingAdminAnnouncement
  >();

  constructor(private readonly moduleRef: ModuleRef) {}

  async executeCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<boolean> {
    if (interaction.commandName !== 'notice-batch') {
      return false;
    }

    await this.cmdNoticeBatch(interaction);
    return true;
  }

  async executeComponentInteraction(
    interaction: Interaction,
  ): Promise<boolean> {
    if (interaction.isButton()) {
      if (!this.isAnnouncementCustomId(interaction.customId)) {
        return false;
      }
      await this.handleNoticeBatchButton(interaction);
      return true;
    }

    if (interaction.isModalSubmit()) {
      if (!this.isAnnouncementCustomId(interaction.customId)) {
        return false;
      }
      await this.handleNoticeBatchModal(interaction);
      return true;
    }

    return false;
  }

  private async cmdNoticeBatch(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const dryRun = interaction.options.getBoolean('dry_run') ?? false;

    const webhookService = this.moduleRef.get(WebhookService, {
      strict: false,
    });

    if (!webhookService) {
      await interaction
        .reply({
          flags: MessageFlags.Ephemeral,
          content: '❌ Required service is unavailable (WebhookService).',
        })
        .catch(() => {});
      return;
    }

    const activeWebhooks = await webhookService.findAll();
    if (activeWebhooks.length === 0) {
      await interaction
        .reply({
          flags: MessageFlags.Ephemeral,
          content: 'ℹ️ 활성화된 웹훅이 없습니다. 공지를 전송할 수 없습니다.',
        })
        .catch(() => {});
      return;
    }

    const token = this.createPendingAnnouncement({
      requestedByUserId: interaction.user.id,
      requestedByTag: interaction.user.tag,
      requestedByAvatarUrl: interaction.user.displayAvatarURL({
        extension: 'png',
        size: 128,
      }),
      dryRun,
      activeWebhookCount: activeWebhooks.length,
      announcementDraft: null,
    });

    const summaryEmbed = this.buildAnnouncementSummaryEmbed({
      activeWebhookCount: activeWebhooks.length,
      dryRun,
      hasDraft: false,
    });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(this.toAnnouncementCustomId('open_modal', token))
        .setLabel('공지 작성')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(this.toAnnouncementCustomId('cancel', token))
        .setLabel('취소')
        .setStyle(ButtonStyle.Secondary),
    );

    await interaction
      .reply({
        flags: MessageFlags.Ephemeral,
        embeds: [summaryEmbed],
        components: [row],
        content:
          '⚠️ 운영자 공지를 작성한 뒤 요약을 확인하고 버튼으로 최종 전송해 주세요.',
      })
      .catch(() => {});
  }

  private async handleNoticeBatchButton(
    interaction: ButtonInteraction,
  ): Promise<void> {
    const parsed = this.parseAnnouncementCustomId(interaction.customId);
    if (!parsed) {
      return;
    }

    const pending = this.getPendingAnnouncement(parsed.token);
    if (!pending) {
      await interaction
        .reply({
          flags: MessageFlags.Ephemeral,
          content:
            '⌛ 확인 요청이 만료되었거나 이미 처리되었습니다. 다시 명령을 실행해 주세요.',
        })
        .catch(() => {});
      return;
    }

    if (pending.requestedByUserId !== interaction.user.id) {
      await interaction
        .reply({
          flags: MessageFlags.Ephemeral,
          content:
            '⛔ 이 확인 요청은 명령을 실행한 관리자만 처리할 수 있습니다.',
        })
        .catch(() => {});
      return;
    }

    if (parsed.action === 'cancel') {
      this.pendingAnnouncements.delete(parsed.token);
      await interaction
        .update({
          content: '🛑 공지 전송 요청이 취소되었습니다.',
          embeds: [],
          components: [],
        })
        .catch(() => {});
      return;
    }

    if (parsed.action === 'confirm_send') {
      if (!pending.announcementDraft) {
        await interaction
          .update({
            content:
              '⛔ 작성된 공지 내용이 없습니다. 먼저 공지를 작성해 주세요.',
            embeds: [],
            components: [
              new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                  .setCustomId(
                    this.toAnnouncementCustomId('open_modal', parsed.token),
                  )
                  .setLabel('공지 작성')
                  .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                  .setCustomId(
                    this.toAnnouncementCustomId('cancel', parsed.token),
                  )
                  .setLabel('취소')
                  .setStyle(ButtonStyle.Secondary),
              ),
            ],
          })
          .catch(() => {});
        return;
      }

      await interaction.deferUpdate().catch(() => {});

      await interaction
        .editReply({
          content: '⏳ 공지 전송을 처리하는 중입니다...',
          components: [],
        })
        .catch(() => {});

      try {
        const result = await this.dispatchAdminAnnouncement({
          requestedByTag: pending.requestedByTag,
          requestedByUserId: pending.requestedByUserId,
          requestedByAvatarUrl: pending.requestedByAvatarUrl,
          draft: pending.announcementDraft,
          dryRun: pending.dryRun,
        });

        this.pendingAnnouncements.delete(parsed.token);

        await interaction.editReply({
          content: result,
          embeds: [],
          components: [],
        });
      } catch (error) {
        await interaction
          .editReply({
            content: `❌ 공지 전송 중 오류가 발생했습니다: ${(error as Error).message}`,
            embeds: [],
            components: [],
          })
          .catch(() => {});
      }
      return;
    }

    if (parsed.action !== 'open_modal') {
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId(this.toAnnouncementCustomId('submit_modal', parsed.token))
      .setTitle('운영자 공지 작성');

    const titleInput = new TextInputBuilder()
      .setCustomId('announcement_title')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(this.ANNOUNCEMENT_TITLE_MAX_LENGTH);

    if (pending.announcementDraft?.title) {
      titleInput.setValue(pending.announcementDraft.title);
    }

    const bodyInput = new TextInputBuilder()
      .setCustomId('announcement_body')
      .setPlaceholder(
        [
          '예시:',
          '- 공지 목적',
          '- 적용 일정',
          '- 영향 범위',
          '- 후속 안내',
        ].join('\n'),
      )
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMinLength(this.ANNOUNCEMENT_BODY_MIN_LENGTH)
      .setMaxLength(this.ANNOUNCEMENT_BODY_MAX_LENGTH);

    if (pending.announcementDraft?.body) {
      bodyInput.setValue(pending.announcementDraft.body);
    }

    const confirmInput = new TextInputBuilder()
      .setCustomId('confirm_keyword')
      .setPlaceholder(this.ANNOUNCEMENT_CONFIRM_KEYWORD)
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMinLength(this.ANNOUNCEMENT_CONFIRM_KEYWORD.length)
      .setMaxLength(this.ANNOUNCEMENT_CONFIRM_KEYWORD.length);

    modal.addComponents(
      new LabelBuilder()
        .setLabel('공지 제목')
        .setTextInputComponent(titleInput),
      new LabelBuilder()
        .setLabel('공지 본문 (여러 줄, 장문 가능)')
        .setTextInputComponent(bodyInput),
      new LabelBuilder()
        .setLabel(`확인 키워드 입력 (${this.ANNOUNCEMENT_CONFIRM_KEYWORD})`)
        .setTextInputComponent(confirmInput),
    );

    try {
      await interaction.showModal(modal);
    } catch (error) {
      this.logger.error(
        `Failed to show admin announcement modal: ${(error as Error).message}`,
      );
      if (!interaction.replied && !interaction.deferred) {
        await interaction
          .reply({
            flags: MessageFlags.Ephemeral,
            content:
              '❌ 공지 작성 모달을 여는 데 실패했습니다. 잠시 후 다시 시도해 주세요.',
          })
          .catch(() => {});
      }
    }
  }

  private async handleNoticeBatchModal(
    interaction: ModalSubmitInteraction,
  ): Promise<void> {
    const parsed = this.parseAnnouncementCustomId(interaction.customId);
    if (!parsed || parsed.action !== 'submit_modal') {
      return;
    }

    const pending = this.getPendingAnnouncement(parsed.token);
    if (!pending) {
      await interaction
        .reply({
          flags: MessageFlags.Ephemeral,
          content:
            '⌛ 확인 요청이 만료되었거나 이미 처리되었습니다. 다시 명령을 실행해 주세요.',
        })
        .catch(() => {});
      return;
    }

    if (pending.requestedByUserId !== interaction.user.id) {
      await interaction
        .reply({
          flags: MessageFlags.Ephemeral,
          content:
            '⛔ 이 확인 요청은 명령을 실행한 관리자만 처리할 수 있습니다.',
        })
        .catch(() => {});
      return;
    }

    const title = interaction.fields
      .getTextInputValue('announcement_title')
      .trim();
    const body = interaction.fields
      .getTextInputValue('announcement_body')
      .trim();
    const keyword = interaction.fields
      .getTextInputValue('confirm_keyword')
      .trim()
      .toUpperCase();

    if (keyword !== this.ANNOUNCEMENT_CONFIRM_KEYWORD) {
      await interaction.deferUpdate().catch(() => {});
      await interaction
        .editReply({
          content: `⛔ 확인 키워드가 일치하지 않습니다. ${this.ANNOUNCEMENT_CONFIRM_KEYWORD} 를 입력해 주세요.`,
          embeds: [],
          components: [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId(
                  this.toAnnouncementCustomId('open_modal', parsed.token),
                )
                .setLabel('다시 작성')
                .setStyle(ButtonStyle.Danger),
              new ButtonBuilder()
                .setCustomId(
                  this.toAnnouncementCustomId('cancel', parsed.token),
                )
                .setLabel('취소')
                .setStyle(ButtonStyle.Secondary),
            ),
          ],
        })
        .catch(() => {});
      return;
    }

    pending.announcementDraft = { title, body };

    const summaryEmbed = this.buildAnnouncementSummaryEmbed({
      activeWebhookCount: pending.activeWebhookCount,
      dryRun: pending.dryRun,
      hasDraft: true,
      title,
      body,
    });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(this.toAnnouncementCustomId('confirm_send', parsed.token))
        .setLabel('최종 전송')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(this.toAnnouncementCustomId('open_modal', parsed.token))
        .setLabel('내용 수정')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(this.toAnnouncementCustomId('cancel', parsed.token))
        .setLabel('취소')
        .setStyle(ButtonStyle.Secondary),
    );

    await interaction.deferUpdate().catch(() => {});

    await interaction
      .editReply({
        content: `확인 키워드 ${this.ANNOUNCEMENT_CONFIRM_KEYWORD} 입력 후 최종 전송 버튼을 눌러주세요.`,
        embeds: [summaryEmbed],
        components: [row],
      })
      .catch(() => {});
  }

  private buildAnnouncementSummaryEmbed(params: {
    activeWebhookCount: number;
    dryRun: boolean;
    hasDraft: boolean;
    title?: string;
    body?: string;
  }): EmbedBuilder {
    const body = params.body ?? '';
    const bodyPreview = this.truncateInline(body, 500);
    const lineCount = body.length > 0 ? body.split(/\r?\n/).length : 0;

    return new EmbedBuilder()
      .setColor(params.dryRun ? 0x3b82f6 : 0xf59e0b)
      .setTitle(
        params.dryRun
          ? '🧪 관리자 공지 Dry-Run 요약'
          : '⚠️ 관리자 공지 전송 요약',
      )
      .addFields(
        {
          name: 'Active Webhooks',
          value: String(params.activeWebhookCount),
          inline: true,
        },
        { name: 'Draft Ready', value: String(params.hasDraft), inline: true },
        {
          name: 'Mode',
          value: params.dryRun ? 'dry-run' : 'send',
          inline: true,
        },
        { name: 'Title', value: params.title ?? '(미작성)', inline: false },
        {
          name: 'Body Preview',
          value: bodyPreview || '(미작성)',
          inline: false,
        },
        {
          name: 'Body Length',
          value: `${body.length} chars / ${lineCount} lines`,
          inline: true,
        },
      )
      .setTimestamp()
      .setFooter({ text: 'LawCast Debug Bridge' });
  }

  private async dispatchAdminAnnouncement(params: {
    requestedByTag: string;
    requestedByUserId: string;
    requestedByAvatarUrl?: string;
    draft: { title: string; body: string };
    dryRun: boolean;
  }): Promise<string> {
    const webhookService = this.moduleRef.get(WebhookService, {
      strict: false,
    });
    const notificationService = this.moduleRef.get(NotificationService, {
      strict: false,
    });

    if (!webhookService || !notificationService) {
      return '❌ 공지 전송에 필요한 서비스(WebhookService/NotificationService)가 준비되지 않았습니다.';
    }

    const webhooks = await webhookService.findAll();
    if (webhooks.length === 0) {
      return 'ℹ️ 활성화된 웹훅이 없어 공지를 전송하지 않았습니다.';
    }

    if (params.dryRun) {
      return `🧪 Dry-run completed: title="${params.draft.title}", webhooks=${webhooks.length}, requested_by=${params.requestedByTag}`;
    }

    const results = await notificationService.sendDiscordAdminAnnouncementBatch(
      {
        title: params.draft.title,
        body: params.draft.body,
        requestedByDisplay: params.requestedByTag,
        requestedByUserId: params.requestedByUserId,
        requestedByAvatarUrl: params.requestedByAvatarUrl,
      },
      webhooks,
    );

    const successCount = results.filter((r) => r.success).length;
    const failureCount = results.length - successCount;
    const permanentFailures = results.filter(
      (r) => !r.success && r.shouldDelete,
    );

    for (const failed of permanentFailures) {
      await webhookService.remove(failed.webhookId).catch(() => {});
      notificationService.clearPermanentFailureFlag(failed.webhookId);
    }

    return [
      '✅ 관리자 공지 전송 완료',
      `requested_by=${params.requestedByTag}`,
      `total=${results.length}`,
      `success=${successCount}`,
      `failed=${failureCount}`,
      `deactivated=${permanentFailures.length}`,
    ].join(', ');
  }

  private createPendingAnnouncement(
    request: Omit<PendingAdminAnnouncement, 'createdAt' | 'expiresAt'>,
  ): string {
    this.cleanupExpiredAnnouncements();
    const token = randomUUID().slice(0, 8);
    const now = Date.now();
    this.pendingAnnouncements.set(token, {
      ...request,
      createdAt: now,
      expiresAt: now + this.ANNOUNCEMENT_TTL_MS,
    });
    return token;
  }

  private cleanupExpiredAnnouncements(): void {
    const now = Date.now();
    for (const [token, request] of this.pendingAnnouncements.entries()) {
      if (request.expiresAt <= now) {
        this.pendingAnnouncements.delete(token);
      }
    }
  }

  private getPendingAnnouncement(
    token: string,
  ): PendingAdminAnnouncement | null {
    this.cleanupExpiredAnnouncements();
    return this.pendingAnnouncements.get(token) ?? null;
  }

  private toAnnouncementCustomId(
    action: 'open_modal' | 'cancel' | 'submit_modal' | 'confirm_send',
    token: string,
  ): string {
    return `${this.ANNOUNCEMENT_PREFIX}:${action}:${token}`;
  }

  private isAnnouncementCustomId(customId: string): boolean {
    return customId.startsWith(`${this.ANNOUNCEMENT_PREFIX}:`);
  }

  private parseAnnouncementCustomId(customId: string): {
    action: 'open_modal' | 'cancel' | 'submit_modal' | 'confirm_send';
    token: string;
  } | null {
    const parts = customId.split(':');
    if (parts.length !== 3) {
      return null;
    }
    if (parts[0] !== this.ANNOUNCEMENT_PREFIX) {
      return null;
    }

    const action = parts[1];
    if (
      action !== 'open_modal' &&
      action !== 'cancel' &&
      action !== 'submit_modal' &&
      action !== 'confirm_send'
    ) {
      return null;
    }

    return { action, token: parts[2] };
  }

  private truncateInline(value: string, maxLength: number): string {
    return value.length <= maxLength
      ? value
      : `${value.slice(0, maxLength - 3)}...`;
  }
}

interface PendingAdminAnnouncement {
  requestedByUserId: string;
  requestedByTag: string;
  requestedByAvatarUrl?: string;
  createdAt: number;
  expiresAt: number;
  dryRun: boolean;
  activeWebhookCount: number;
  announcementDraft: {
    title: string;
    body: string;
  } | null;
}
