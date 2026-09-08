import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  ContainerBuilder,
  Interaction,
  MessageFlags,
  ModalBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { LoggerUtils } from '../../utils/logger.utils';
import type {
  DiscussionsService,
  SanitizedComment,
  SanitizedThread,
  SanitizedThreadWithNotice,
} from '../discussions/discussions.service';
import { DiscussionMessageType } from '../discussions/entities/discussion-comment.entity';
import { DiscussionThreadStatus } from '../discussions/entities/discussion-thread.entity';

const PREFIX = 'da';
const THREADS_PER_PAGE = 5;
const COMMENTS_PER_PAGE = 8;
const NO_FILTER = '-';
const REPLY_FLAGS = MessageFlags.Ephemeral | MessageFlags.IsComponentsV2;

type StatusFilter = DiscussionThreadStatus | undefined;

function encodeStatusFilter(status: StatusFilter): string {
  return status ?? NO_FILTER;
}

function decodeStatusFilter(raw: string): StatusFilter {
  return raw === DiscussionThreadStatus.OPEN ||
    raw === DiscussionThreadStatus.CLOSED
    ? raw
    : undefined;
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatDateTime(iso: string | Date): string {
  const date = iso instanceof Date ? iso : new Date(iso);
  return date.toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Discord debug-bridge admin commands for moderating anonymous discussion
 * threads: browsing threads/opinions and force closing/opening threads or
 * hiding individual opinions, all state encoded in component customIds so no
 * in-memory session map is needed across restarts.
 */
@Injectable()
export class DiscordBridgeDiscussionsCommandsService {
  private readonly logger = LoggerUtils.getContextLogger(
    DiscordBridgeDiscussionsCommandsService.name,
  );

  constructor(private readonly moduleRef: ModuleRef) {}

  async executeCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<boolean> {
    if (interaction.commandName !== 'discussion-admin') {
      return false;
    }

    const subcommand = interaction.options.getSubcommand();
    switch (subcommand) {
      case 'list':
        await this.cmdList(interaction);
        return true;
      case 'close':
        await this.cmdSetStatus(interaction, DiscussionThreadStatus.CLOSED);
        return true;
      case 'open':
        await this.cmdSetStatus(interaction, DiscussionThreadStatus.OPEN);
        return true;
      case 'lock':
        await this.cmdSetLock(interaction, true);
        return true;
      case 'unlock':
        await this.cmdSetLock(interaction, false);
        return true;
      case 'hide-comment':
        await this.cmdHideComment(interaction);
        return true;
      case 'post-message':
        await this.cmdPostMessage(interaction);
        return true;
      default:
        return false;
    }
  }

  async executeComponentInteraction(
    interaction: Interaction,
  ): Promise<boolean> {
    if (interaction.isButton()) {
      if (!interaction.customId.startsWith(`${PREFIX}:`)) return false;
      await this.handleButton(interaction);
      return true;
    }

    if (interaction.isStringSelectMenu()) {
      if (!interaction.customId.startsWith(`${PREFIX}:`)) return false;
      await this.handleSelectMenu(interaction);
      return true;
    }

    if (interaction.isModalSubmit()) {
      if (!interaction.customId.startsWith(`${PREFIX}:`)) return false;
      await this.handleModalSubmit(interaction);
      return true;
    }

    return false;
  }

  // ─── Slash command handlers ────────────────────────────────────────────

  private async cmdList(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const status = decodeStatusFilter(
      interaction.options.getString('status') ?? NO_FILTER,
    );
    const page = Math.max(1, interaction.options.getInteger('page') ?? 1);

    const discussionsService = await this.getDiscussionsService();
    const result = await discussionsService.getAllThreads(
      page,
      THREADS_PER_PAGE,
      status,
    );

    await interaction.reply({
      flags: REPLY_FLAGS,
      components: this.buildListComponents(result, status),
    });
  }

  private async cmdSetStatus(
    interaction: ChatInputCommandInteraction,
    status: DiscussionThreadStatus,
  ): Promise<void> {
    const threadId = interaction.options.getInteger('thread_id', true);
    const discussionsService = await this.getDiscussionsService();
    const thread = await discussionsService.adminSetThreadStatus(
      threadId,
      status,
    );

    const label = status === DiscussionThreadStatus.CLOSED ? '닫혔' : '열렸';
    await interaction
      .reply({
        flags: MessageFlags.Ephemeral,
        content: `✅ 토론 #${thread.id} (${thread.title})가 강제로 ${label}습니다.`,
      })
      .catch(() => {});
  }

  private async cmdSetLock(
    interaction: ChatInputCommandInteraction,
    locked: boolean,
  ): Promise<void> {
    const threadId = interaction.options.getInteger('thread_id', true);
    const discussionsService = await this.getDiscussionsService();
    const thread = await discussionsService.adminSetThreadLock(
      threadId,
      locked,
    );

    const label = locked ? '잠겼' : '잠금 해제되었';
    await interaction
      .reply({
        flags: MessageFlags.Ephemeral,
        content: `✅ 토론 #${thread.id} (${thread.title})가 ${label}습니다.`,
      })
      .catch(() => {});
  }

  private async cmdHideComment(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const commentId = interaction.options.getInteger('comment_id', true);
    const discussionsService = await this.getDiscussionsService();
    const comment = await discussionsService.adminHideComment(commentId);

    await interaction
      .reply({
        flags: MessageFlags.Ephemeral,
        content: `✅ 의견 #${comment.id} (스레드 #${comment.threadId}, ${comment.sequence}번)가 숨겨졌습니다.`,
      })
      .catch(() => {});
  }

  private async cmdPostMessage(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const threadId = interaction.options.getInteger('thread_id', true);
    const message = interaction.options.getString('message', true);
    const label = interaction.options.getString('label') ?? undefined;
    const discussionsService = await this.getDiscussionsService();
    const comment = await discussionsService.adminPostMessage(
      threadId,
      message,
      label,
    );

    await interaction
      .reply({
        flags: MessageFlags.Ephemeral,
        content: `✅ 토론 #${threadId}에 관리자 메시지(#${comment.sequence})를 게시했습니다.`,
      })
      .catch(() => {});
  }

  // ─── Component interaction handlers ────────────────────────────────────

  private async handleButton(
    interaction: import('discord.js').ButtonInteraction,
  ): Promise<void> {
    const parts = interaction.customId.split(':');
    const action = parts[1];
    const discussionsService = await this.getDiscussionsService();

    if (action === 'page') {
      const page = Number.parseInt(parts[2], 10);
      const status = decodeStatusFilter(parts[3]);
      const result = await discussionsService.getAllThreads(
        page,
        THREADS_PER_PAGE,
        status,
      );
      await interaction
        .update({ components: this.buildListComponents(result, status) })
        .catch(() => {});
      return;
    }

    if (action === 'back') {
      const page = Number.parseInt(parts[2], 10);
      const status = decodeStatusFilter(parts[3]);
      const result = await discussionsService.getAllThreads(
        page,
        THREADS_PER_PAGE,
        status,
      );
      await interaction
        .update({ components: this.buildListComponents(result, status) })
        .catch(() => {});
      return;
    }

    if (action === 'cprev' || action === 'cnext') {
      const threadId = Number.parseInt(parts[2], 10);
      const currentCommentPage = Number.parseInt(parts[3], 10);
      const listPage = Number.parseInt(parts[4], 10);
      const listStatus = decodeStatusFilter(parts[5]);
      const targetCommentPage = Math.max(
        1,
        action === 'cprev' ? currentCommentPage - 1 : currentCommentPage + 1,
      );
      await this.updateDetailView(
        interaction,
        threadId,
        targetCommentPage,
        listPage,
        listStatus,
      );
      return;
    }

    if (action === 'toggle') {
      const threadId = Number.parseInt(parts[2], 10);
      const commentPage = Number.parseInt(parts[3], 10);
      const listPage = Number.parseInt(parts[4], 10);
      const listStatus = decodeStatusFilter(parts[5]);
      const thread = await discussionsService.getThreadDetail(threadId, 0, 1);
      const nextStatus =
        thread.thread.status === DiscussionThreadStatus.OPEN
          ? DiscussionThreadStatus.CLOSED
          : DiscussionThreadStatus.OPEN;
      await discussionsService.adminSetThreadStatus(threadId, nextStatus);
      await this.updateDetailView(
        interaction,
        threadId,
        commentPage,
        listPage,
        listStatus,
      );
      return;
    }

    if (action === 'lock') {
      const threadId = Number.parseInt(parts[2], 10);
      const commentPage = Number.parseInt(parts[3], 10);
      const listPage = Number.parseInt(parts[4], 10);
      const listStatus = decodeStatusFilter(parts[5]);
      const thread = await discussionsService.getThreadDetail(threadId, 0, 1);
      await discussionsService.adminSetThreadLock(
        threadId,
        !thread.thread.isLocked,
      );
      await this.updateDetailView(
        interaction,
        threadId,
        commentPage,
        listPage,
        listStatus,
      );
      return;
    }

    if (action === 'postbtn') {
      const threadId = Number.parseInt(parts[2], 10);
      const commentPage = Number.parseInt(parts[3], 10);
      const listPage = Number.parseInt(parts[4], 10);
      const listStatus = decodeStatusFilter(parts[5]);
      const modal = new ModalBuilder()
        .setCustomId(
          `${PREFIX}:postmodal:${threadId}:${commentPage}:${listPage}:${listStatus}`,
        )
        .setTitle('관리자 메시지 작성')
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId('content')
              .setLabel('메시지 내용')
              .setStyle(TextInputStyle.Paragraph)
              .setMaxLength(2000)
              .setRequired(true),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId('label')
              .setLabel('작성자 표시명 (기본값: 운영진)')
              .setStyle(TextInputStyle.Short)
              .setMaxLength(50)
              .setRequired(false),
          ),
        );
      await interaction.showModal(modal).catch(() => {});
      return;
    }
  }

  private async handleModalSubmit(
    interaction: import('discord.js').ModalSubmitInteraction,
  ): Promise<void> {
    const parts = interaction.customId.split(':');
    const action = parts[1];
    if (action !== 'postmodal') return;

    const threadId = Number.parseInt(parts[2], 10);
    const commentPage = Number.parseInt(parts[3], 10);
    const listPage = Number.parseInt(parts[4], 10);
    const listStatus = decodeStatusFilter(parts[5]);
    const content = interaction.fields.getTextInputValue('content');
    const label = interaction.fields.getTextInputValue('label') || undefined;

    const discussionsService = await this.getDiscussionsService();
    await discussionsService.adminPostMessage(threadId, content, label);

    const detail = await discussionsService.getThreadDetail(
      threadId,
      (Math.max(1, commentPage) - 1) * COMMENTS_PER_PAGE,
      COMMENTS_PER_PAGE,
    );
    const components = await this.buildDetailComponents(
      detail.thread,
      detail.comments,
      Math.max(1, commentPage),
      listPage,
      listStatus,
    );
    if (!interaction.isFromMessage()) return;
    await interaction.update({ components }).catch((error: unknown) => {
      this.logger.warn(
        `Failed to render discussion admin detail view after posting a message: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  private async handleSelectMenu(
    interaction: import('discord.js').StringSelectMenuInteraction,
  ): Promise<void> {
    const parts = interaction.customId.split(':');
    const action = parts[1];
    const discussionsService = await this.getDiscussionsService();

    if (action === 'selthread') {
      const listPage = Number.parseInt(parts[2], 10);
      const listStatus = decodeStatusFilter(parts[3]);
      const threadId = Number.parseInt(interaction.values[0], 10);
      await this.updateDetailView(
        interaction,
        threadId,
        1,
        listPage,
        listStatus,
      );
      return;
    }

    if (action === 'selcomment') {
      const threadId = Number.parseInt(parts[2], 10);
      const commentPage = Number.parseInt(parts[3], 10);
      const listPage = Number.parseInt(parts[4], 10);
      const listStatus = decodeStatusFilter(parts[5]);
      const commentId = Number.parseInt(interaction.values[0], 10);
      await discussionsService.adminHideComment(commentId);
      await this.updateDetailView(
        interaction,
        threadId,
        commentPage,
        listPage,
        listStatus,
      );
      return;
    }
  }

  // ─── Panel rendering ────────────────────────────────────────────────────

  private buildListComponents(
    result: {
      items: SanitizedThreadWithNotice[];
      total: number;
      page: number;
      limit: number;
    },
    status: StatusFilter,
  ): ContainerBuilder[] {
    const totalPages = Math.max(1, Math.ceil(result.total / result.limit));
    const statusLabel =
      status === DiscussionThreadStatus.OPEN
        ? '진행 중'
        : status === DiscussionThreadStatus.CLOSED
          ? '닫힘'
          : '전체';

    const container = new ContainerBuilder().addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### 🗂️ 토론 스레드 관리\n상태 필터: **${statusLabel}** · 총 ${result.total}개 · 페이지 ${result.page}/${totalPages}`,
      ),
    );

    container.addSeparatorComponents((separator) =>
      separator.setSpacing(SeparatorSpacingSize.Small),
    );

    if (result.items.length === 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('조건에 맞는 토론이 없습니다.'),
      );
    } else {
      const lines = result.items.map((thread) => {
        const statusIcon =
          thread.status === DiscussionThreadStatus.OPEN ? '🟢' : '🔒';
        const lockIcon = thread.isLocked ? '🔐' : '';
        const noticeLabel = thread.noticeSubject
          ? `${thread.noticeNum} · ${truncate(thread.noticeSubject, 40)}`
          : String(thread.noticeNum);
        return `${statusIcon}${lockIcon} **#${thread.id}** ${truncate(thread.title, 60)}\n의안번호 ${noticeLabel} · 의견 ${thread.commentCount}개 · ${formatDateTime(thread.updatedAt)}`;
      });
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(lines.join('\n\n')),
      );
    }

    const statusFilterId = encodeStatusFilter(status);
    const pageButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${PREFIX}:page:${result.page - 1}:${statusFilterId}`)
        .setLabel('◀ 이전')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(result.page <= 1),
      new ButtonBuilder()
        .setCustomId(`${PREFIX}:page:${result.page + 1}:${statusFilterId}`)
        .setLabel('다음 ▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(result.page >= totalPages),
    );
    container.addActionRowComponents(pageButtons);

    if (result.items.length > 0) {
      const select = new StringSelectMenuBuilder()
        .setCustomId(`${PREFIX}:selthread:${result.page}:${statusFilterId}`)
        .setPlaceholder('관리할 토론 스레드를 선택하세요')
        .addOptions(
          result.items.map((thread) =>
            new StringSelectMenuOptionBuilder()
              .setLabel(truncate(`#${thread.id} ${thread.title}`, 100))
              .setDescription(
                truncate(
                  `${thread.status === DiscussionThreadStatus.OPEN ? '진행 중' : '닫힘'} · 의견 ${thread.commentCount}개`,
                  100,
                ),
              )
              .setValue(String(thread.id)),
          ),
        );
      container.addActionRowComponents(
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      );
    }

    return [container];
  }

  private async buildDetailComponents(
    thread: SanitizedThread,
    comments: SanitizedComment[],
    commentPage: number,
    listPage: number,
    listStatus: StatusFilter,
  ): Promise<ContainerBuilder[]> {
    const listStatusId = encodeStatusFilter(listStatus);
    const totalCommentPages = Math.max(
      1,
      Math.ceil(thread.commentCount / COMMENTS_PER_PAGE),
    );
    const statusLabel =
      thread.status === DiscussionThreadStatus.OPEN ? '🟢 진행 중' : '🔒 닫힘';
    const lockLabel = thread.isLocked ? ' · 🔐 잠김' : '';

    const container = new ContainerBuilder().addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### 💬 토론 #${thread.id} 상세\n${truncate(thread.title, 100)}\n상태: ${statusLabel}${lockLabel} · 의안번호 ${thread.noticeNum} · 의견 ${thread.commentCount}개 · 페이지 ${commentPage}/${totalCommentPages}`,
      ),
    );

    container.addSeparatorComponents((separator) =>
      separator.setSpacing(SeparatorSpacingSize.Small),
    );

    const hideableComments = comments.filter(
      (comment) =>
        !comment.isDeleted &&
        comment.messageType !== DiscussionMessageType.SYSTEM,
    );

    if (comments.length === 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('등록된 의견이 없습니다.'),
      );
    } else {
      const lines = comments.map((comment) => {
        const icon =
          comment.messageType === DiscussionMessageType.SYSTEM
            ? '⚙️'
            : comment.messageType === DiscussionMessageType.ADMIN
              ? '📢'
              : comment.isDeleted
                ? '🚫'
                : '💬';
        const content = comment.isDeleted
          ? '(숨겨진 의견입니다)'
          : truncate(comment.content, 100);
        return `${icon} **#${comment.sequence}** ${comment.authorNickname}\n${content}`;
      });
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(lines.join('\n\n')),
      );
    }

    const statusButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${PREFIX}:back:${listPage}:${listStatusId}`)
        .setLabel('◀ 목록으로')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(
          `${PREFIX}:toggle:${thread.id}:${commentPage}:${listPage}:${listStatusId}`,
        )
        .setLabel(
          thread.status === DiscussionThreadStatus.OPEN
            ? '🔒 강제 닫기'
            : '🔓 강제 열기',
        )
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(
          `${PREFIX}:lock:${thread.id}:${commentPage}:${listPage}:${listStatusId}`,
        )
        .setLabel(thread.isLocked ? '🔓 잠금 해제' : '🔐 강제 잠금')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(
          `${PREFIX}:postbtn:${thread.id}:${commentPage}:${listPage}:${listStatusId}`,
        )
        .setLabel('📢 관리자 메시지')
        .setStyle(ButtonStyle.Primary),
    );
    container.addActionRowComponents(statusButtons);

    const pageButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(
          `${PREFIX}:cprev:${thread.id}:${commentPage}:${listPage}:${listStatusId}`,
        )
        .setLabel('◀ 이전 의견')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(commentPage <= 1),
      new ButtonBuilder()
        .setCustomId(`${PREFIX}:noop`)
        .setLabel(`${commentPage} / ${totalCommentPages}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(
          `${PREFIX}:cnext:${thread.id}:${commentPage}:${listPage}:${listStatusId}`,
        )
        .setLabel('다음 의견 ▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(commentPage >= totalCommentPages),
    );
    container.addActionRowComponents(pageButtons);

    if (hideableComments.length > 0) {
      const select = new StringSelectMenuBuilder()
        .setCustomId(
          `${PREFIX}:selcomment:${thread.id}:${commentPage}:${listPage}:${listStatusId}`,
        )
        .setPlaceholder('숨길 의견을 선택하세요')
        .addOptions(
          hideableComments.map((comment) =>
            new StringSelectMenuOptionBuilder()
              .setLabel(
                truncate(`#${comment.sequence} ${comment.authorNickname}`, 100),
              )
              .setDescription(truncate(comment.content, 100))
              .setValue(String(comment.id)),
          ),
        );
      container.addActionRowComponents(
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      );
    }

    return [container];
  }

  private async updateDetailView(
    interaction:
      | import('discord.js').ButtonInteraction
      | import('discord.js').StringSelectMenuInteraction,
    threadId: number,
    commentPage: number,
    listPage: number,
    listStatus: StatusFilter,
  ): Promise<void> {
    const discussionsService = await this.getDiscussionsService();
    const cursor = (Math.max(1, commentPage) - 1) * COMMENTS_PER_PAGE;
    const detail = await discussionsService.getThreadDetail(
      threadId,
      cursor,
      COMMENTS_PER_PAGE,
    );
    const components = await this.buildDetailComponents(
      detail.thread,
      detail.comments,
      Math.max(1, commentPage),
      listPage,
      listStatus,
    );
    await interaction.update({ components }).catch((error: unknown) => {
      this.logger.warn(
        `Failed to render discussion admin detail view: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  private async getDiscussionsService(): Promise<DiscussionsService> {
    const { DiscussionsService } =
      await import('../discussions/discussions.service');
    return this.moduleRef.get(DiscussionsService, { strict: false });
  }
}
