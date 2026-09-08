import { MessageFlags } from 'discord.js';
import { DiscordBridgeAdminAnnouncementCommandService } from './discord-bridge-admin-announcement-command.service';

jest.mock('../notification/notification.service', () => ({ NotificationService: class {} }));
jest.mock('../webhook/webhook.service', () => ({ WebhookService: class {} }));

const PREFIX = 'admin_announcement';

describe('DiscordBridgeAdminAnnouncementCommandService', () => {
  function createService(get: jest.Mock) {
    const service = new DiscordBridgeAdminAnnouncementCommandService({ get } as any);
    return service;
  }

  function createChatInputInteraction(overrides: Record<string, unknown> = {}) {
    return {
      commandName: 'notice-batch',
      user: {
        id: 'user-1',
        tag: 'admin#1234',
        displayAvatarURL: jest.fn().mockReturnValue('https://avatar/me.png'),
      },
      options: {
        getBoolean: jest.fn().mockReturnValue(false),
      },
      reply: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    } as any;
  }

  function createButtonInteraction(
    customId: string,
    userId = 'user-1',
    overrides: Record<string, unknown> = {},
  ) {
    return {
      customId,
      isButton: () => true,
      isModalSubmit: () => false,
      user: { id: userId },
      reply: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
      deferUpdate: jest.fn().mockResolvedValue(undefined),
      editReply: jest.fn().mockResolvedValue(undefined),
      showModal: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    } as any;
  }

  function createModalInteraction(
    customId: string,
    fields: Record<string, string>,
    userId = 'user-1',
    overrides: Record<string, unknown> = {},
  ) {
    return {
      customId,
      isButton: () => false,
      isModalSubmit: () => true,
      user: { id: userId },
      fields: {
        getTextInputValue: (name: string) => fields[name] ?? '',
      },
      reply: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
      deferUpdate: jest.fn().mockResolvedValue(undefined),
      editReply: jest.fn().mockResolvedValue(undefined),
      showModal: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    } as any;
  }

  function extractTokenFromReply(reply: jest.Mock): string {
    const replyArgs = reply.mock.calls[0][0];
    const row = replyArgs.components[0];
    const button = row.components[0];
    const customId: string = button.data.custom_id;
    return customId.split(':')[2];
  }

  const webhooks = [
    { id: 1, url: 'https://discord.com/api/webhooks/1' },
    { id: 2, url: 'https://discord.com/api/webhooks/2' },
  ];

  describe('executeCommand', () => {
    it('ignores commands that are not notice-batch', async () => {
      const service = createService(jest.fn());
      const interaction = createChatInputInteraction({ commandName: 'status' });

      await expect(service.executeCommand(interaction)).resolves.toBe(false);
      expect(interaction.reply).not.toHaveBeenCalled();
    });

    it('replies with an error when WebhookService is unavailable', async () => {
      const service = createService(jest.fn().mockReturnValue(undefined));
      const interaction = createChatInputInteraction();

      const handled = await service.executeCommand(interaction);

      expect(handled).toBe(true);
      expect(interaction.reply).toHaveBeenCalledWith({
        flags: MessageFlags.Ephemeral,
        content: '❌ Required service is unavailable (WebhookService).',
      });
    });

    it('replies when there are no active webhooks', async () => {
      const webhookService = { findAll: jest.fn().mockResolvedValue([]) };
      const service = createService(jest.fn().mockReturnValue(webhookService));
      const interaction = createChatInputInteraction();

      await service.executeCommand(interaction);

      expect(interaction.reply).toHaveBeenCalledWith({
        flags: MessageFlags.Ephemeral,
        content: 'ℹ️ 활성화된 웹훅이 없습니다. 공지를 전송할 수 없습니다.',
      });
    });

    it('starts a pending announcement and replies with a summary embed and buttons', async () => {
      const webhookService = { findAll: jest.fn().mockResolvedValue(webhooks) };
      const service = createService(jest.fn().mockReturnValue(webhookService));
      const interaction = createChatInputInteraction();

      const handled = await service.executeCommand(interaction);

      expect(handled).toBe(true);
      expect(interaction.reply).toHaveBeenCalledTimes(1);
      const replyArgs = interaction.reply.mock.calls[0][0];
      expect(replyArgs.flags).toBe(MessageFlags.Ephemeral);
      expect(replyArgs.embeds).toHaveLength(1);
      expect(replyArgs.components).toHaveLength(1);
      const customIds = replyArgs.components[0].components.map(
        (button: any) => button.data.custom_id,
      );
      expect(customIds[0]).toMatch(new RegExp(`^${PREFIX}:open_modal:[a-f0-9]{8}$`));
      expect(customIds[1]).toMatch(new RegExp(`^${PREFIX}:cancel:[a-f0-9]{8}$`));
    });

    it('honors the dry_run flag in the summary embed', async () => {
      const webhookService = { findAll: jest.fn().mockResolvedValue(webhooks) };
      const service = createService(jest.fn().mockReturnValue(webhookService));
      const interaction = createChatInputInteraction({
        options: { getBoolean: jest.fn().mockReturnValue(true) },
      });

      await service.executeCommand(interaction);

      const replyArgs = interaction.reply.mock.calls[0][0];
      expect(replyArgs.embeds[0].data.title).toBe('🧪 관리자 공지 Dry-Run 요약');
      expect(replyArgs.embeds[0].data.fields[2].value).toBe('dry-run');
    });
  });

  describe('executeComponentInteraction', () => {
    it('ignores buttons that do not use the announcement prefix', async () => {
      const service = createService(jest.fn());
      const interaction = createButtonInteraction('other:action');

      await expect(service.executeComponentInteraction(interaction)).resolves.toBe(false);
      expect(interaction.reply).not.toHaveBeenCalled();
    });

    it('ignores modals that do not use the announcement prefix', async () => {
      const service = createService(jest.fn());
      const interaction = createModalInteraction('other:submit_modal:abc', {});

      await expect(service.executeComponentInteraction(interaction)).resolves.toBe(false);
    });

    it('ignores unsupported interaction types', async () => {
      const service = createService(jest.fn());
      const interaction = {
        isButton: () => false,
        isModalSubmit: () => false,
        customId: 'admin_announcement:open_modal:abc',
      } as any;

      await expect(service.executeComponentInteraction(interaction)).resolves.toBe(false);
    });

    it('replies when the pending announcement has expired or is missing', async () => {
      const service = createService(jest.fn());
      const interaction = createButtonInteraction(
        `${PREFIX}:open_modal:deadbeef`,
      );

      const handled = await service.executeComponentInteraction(interaction);

      expect(handled).toBe(true);
      expect(interaction.reply).toHaveBeenCalledWith({
        flags: MessageFlags.Ephemeral,
        content:
          '⌛ 확인 요청이 만료되었거나 이미 처리되었습니다. 다시 명령을 실행해 주세요.',
      });
    });

    it('rejects a different user trying to handle the confirmation', async () => {
      const webhookService = { findAll: jest.fn().mockResolvedValue(webhooks) };
      const service = createService(jest.fn().mockReturnValue(webhookService));
      const interaction = createChatInputInteraction();
      await service.executeCommand(interaction);
      const token = extractTokenFromReply(interaction.reply);

      const buttonInteraction = createButtonInteraction(
        `${PREFIX}:cancel:${token}`,
        'user-2',
      );
      await service.executeComponentInteraction(buttonInteraction);

      expect(buttonInteraction.reply).toHaveBeenCalledWith({
        flags: MessageFlags.Ephemeral,
        content: '⛔ 이 확인 요청은 명령을 실행한 관리자만 처리할 수 있습니다.',
      });
      expect(buttonInteraction.update).not.toHaveBeenCalled();
    });

    it('cancels the pending announcement on the cancel button', async () => {
      const webhookService = { findAll: jest.fn().mockResolvedValue(webhooks) };
      const service = createService(jest.fn().mockReturnValue(webhookService));
      const interaction = createChatInputInteraction();
      await service.executeCommand(interaction);
      const token = extractTokenFromReply(interaction.reply);

      const buttonInteraction = createButtonInteraction(
        `${PREFIX}:cancel:${token}`,
      );
      await service.executeComponentInteraction(buttonInteraction);

      expect(buttonInteraction.update).toHaveBeenCalledWith({
        content: '🛑 공지 전송 요청이 취소되었습니다.',
        embeds: [],
        components: [],
      });

      // The same token must now be treated as expired
      const secondClick = createButtonInteraction(`${PREFIX}:cancel:${token}`);
      await service.executeComponentInteraction(secondClick);
      expect(secondClick.reply).toHaveBeenCalledWith({
        flags: MessageFlags.Ephemeral,
        content:
          '⌛ 확인 요청이 만료되었거나 이미 처리되었습니다. 다시 명령을 실행해 주세요.',
      });
    });

    it('shows the announcement modal on the open_modal button', async () => {
      const webhookService = { findAll: jest.fn().mockResolvedValue(webhooks) };
      const service = createService(jest.fn().mockReturnValue(webhookService));
      const interaction = createChatInputInteraction();
      await service.executeCommand(interaction);
      const token = extractTokenFromReply(interaction.reply);

      const buttonInteraction = createButtonInteraction(
        `${PREFIX}:open_modal:${token}`,
      );
      await service.executeComponentInteraction(buttonInteraction);

      expect(buttonInteraction.showModal).toHaveBeenCalledTimes(1);
      const modal = buttonInteraction.showModal.mock.calls[0][0];
      expect(modal.data.title).toBe('운영자 공지 작성');
      expect(modal.data.custom_id).toBe(`${PREFIX}:submit_modal:${token}`);
    });

    it('replies on the confirm button when no draft has been written yet', async () => {
      const webhookService = { findAll: jest.fn().mockResolvedValue(webhooks) };
      const service = createService(jest.fn().mockReturnValue(webhookService));
      const interaction = createChatInputInteraction();
      await service.executeCommand(interaction);
      const token = extractTokenFromReply(interaction.reply);

      const buttonInteraction = createButtonInteraction(
        `${PREFIX}:confirm_send:${token}`,
      );
      await service.executeComponentInteraction(buttonInteraction);

      expect(buttonInteraction.update).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '⛔ 작성된 공지 내용이 없습니다. 먼저 공지를 작성해 주세요.',
        }),
      );
    });
  });

  describe('announcement modal flow', () => {
    async function createServiceWithPendingDraft(get: jest.Mock) {
      const service = createService(get);
      const chatInput = createChatInputInteraction();
      await service.executeCommand(chatInput);
      const token = extractTokenFromReply(chatInput.reply);

      const modal = createModalInteraction(`${PREFIX}:submit_modal:${token}`, {
        announcement_title: '시스템 점검 안내',
        announcement_body: '금일 22시부터 23시까지 시스템 점검을 진행합니다.',
        confirm_keyword: 'send',
      });
      await service.executeComponentInteraction(modal);
      return { service, token, modal };
    }

    it('rejects a mismatched confirm keyword and keeps the draft flow open', async () => {
      const webhookService = { findAll: jest.fn().mockResolvedValue(webhooks) };
      const service = createService(jest.fn().mockReturnValue(webhookService));
      const chatInput = createChatInputInteraction();
      await service.executeCommand(chatInput);
      const token = extractTokenFromReply(chatInput.reply);

      const modal = createModalInteraction(`${PREFIX}:submit_modal:${token}`, {
        announcement_title: '시스템 점검 안내',
        announcement_body: '금일 22시부터 23시까지 시스템 점검을 진행합니다.',
        confirm_keyword: 'wrong',
      });
      await service.executeComponentInteraction(modal);

      expect(modal.deferUpdate).toHaveBeenCalledTimes(1);
      expect(modal.editReply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '⛔ 확인 키워드가 일치하지 않습니다. SEND 를 입력해 주세요.',
        }),
      );
      const components = modal.editReply.mock.calls[0][0].components;
      const customIds = components[0].components.map(
        (button: any) => button.data.custom_id,
      );
      expect(customIds[0]).toBe(`${PREFIX}:open_modal:${token}`);
      expect(customIds[1]).toBe(`${PREFIX}:cancel:${token}`);
    });

    it('stores the draft and shows the confirm summary after a valid keyword', async () => {
      const webhookService = { findAll: jest.fn().mockResolvedValue(webhooks) };
      const service = createService(jest.fn().mockReturnValue(webhookService));
      const chatInput = createChatInputInteraction();
      await service.executeCommand(chatInput);
      const token = extractTokenFromReply(chatInput.reply);

      const modal = createModalInteraction(`${PREFIX}:submit_modal:${token}`, {
        announcement_title: '시스템 점검 안내',
        announcement_body: '금일 22시부터 23시까지 시스템 점검을 진행합니다.',
        confirm_keyword: 'send',
      });
      await service.executeComponentInteraction(modal);

      expect(modal.editReply).toHaveBeenCalledTimes(1);
      const replyArgs = modal.editReply.mock.calls[0][0];
      expect(replyArgs.content).toContain('확인 키워드 SEND 입력 후 최종 전송 버튼을 눌러주세요.');
      expect(replyArgs.embeds[0].data.title).toBe('⚠️ 관리자 공지 전송 요약');
      expect(replyArgs.embeds[0].data.fields[3].value).toBe('시스템 점검 안내');
      const customIds = replyArgs.components[0].components.map(
        (button: any) => button.data.custom_id,
      );
      expect(customIds[0]).toBe(`${PREFIX}:confirm_send:${token}`);
    });
  });

  describe('dispatch flow', () => {
    async function createServiceWithDraft(get: jest.Mock) {
      const service = createService(get);
      const chatInput = createChatInputInteraction();
      await service.executeCommand(chatInput);
      const token = extractTokenFromReply(chatInput.reply);

      const modal = createModalInteraction(`${PREFIX}:submit_modal:${token}`, {
        announcement_title: '시스템 점검 안내',
        announcement_body: '금일 22시부터 23시까지 시스템 점검을 진행합니다.',
        confirm_keyword: 'send',
      });
      await service.executeComponentInteraction(modal);
      return { service, token };
    }

    it('completes a dry-run send without dispatching to webhooks', async () => {
      const webhookService = { findAll: jest.fn().mockResolvedValue(webhooks) };
      const notificationService = {
        sendDiscordAdminAnnouncementBatch: jest.fn(),
        clearPermanentFailureFlag: jest.fn(),
      };
      const get = jest
        .fn()
        .mockReturnValueOnce(webhookService) // executeCommand (send mode)
        .mockReturnValueOnce(webhookService) // executeCommand (dry-run mode)
        .mockReturnValueOnce(webhookService) // dispatch webhookService
        .mockReturnValueOnce(notificationService); // dispatch notificationService
      const { service } = await createServiceWithDraft(get);

      // Re-run the command in dry-run mode so the pending entry is a dry run
      const dryRunChatInput = createChatInputInteraction({
        options: { getBoolean: jest.fn().mockReturnValue(true) },
      });
      await service.executeCommand(dryRunChatInput);
      const dryRunToken = extractTokenFromReply(dryRunChatInput.reply);

      // Write a draft for the dry-run entry
      const dryRunModal = createModalInteraction(
        `${PREFIX}:submit_modal:${dryRunToken}`,
        {
          announcement_title: '시스템 점검 안내',
          announcement_body: '금일 22시부터 23시까지 시스템 점검을 진행합니다.',
          confirm_keyword: 'send',
        },
      );
      await service.executeComponentInteraction(dryRunModal);

      const buttonInteraction = createButtonInteraction(
        `${PREFIX}:confirm_send:${dryRunToken}`,
      );
      await service.executeComponentInteraction(buttonInteraction);

      expect(notificationService.sendDiscordAdminAnnouncementBatch).not.toHaveBeenCalled();
      expect(buttonInteraction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('🧪 Dry-run completed'),
        }),
      );
      // The stale draft from the first run was not sent either
      expect(notificationService.sendDiscordAdminAnnouncementBatch).not.toHaveBeenCalled();
    });

    it('sends the announcement and reports per-webhook results', async () => {
      const webhookService = {
        findAll: jest.fn().mockResolvedValue(webhooks),
        remove: jest.fn().mockResolvedValue(undefined),
      };
      const notificationService = {
        sendDiscordAdminAnnouncementBatch: jest
          .fn()
          .mockResolvedValue([
            { webhookId: 1, success: true },
            { webhookId: 2, success: false, shouldDelete: true, error: new Error('410 Gone') },
          ]),
        clearPermanentFailureFlag: jest.fn(),
      };
      const get = jest
        .fn()
        .mockReturnValueOnce(webhookService) // cmdNoticeBatch
        .mockReturnValueOnce(webhookService) // dispatch webhookService
        .mockReturnValueOnce(notificationService); // dispatch notificationService
      const { service, token } = await createServiceWithDraft(get);

      const buttonInteraction = createButtonInteraction(
        `${PREFIX}:confirm_send:${token}`,
      );
      await service.executeComponentInteraction(buttonInteraction);

      expect(notificationService.sendDiscordAdminAnnouncementBatch).toHaveBeenCalledWith(
        expect.objectContaining({
          title: '시스템 점검 안내',
          body: '금일 22시부터 23시까지 시스템 점검을 진행합니다.',
          requestedByDisplay: 'admin#1234',
          requestedByUserId: 'user-1',
        }),
        webhooks,
      );
      expect(webhookService.remove).toHaveBeenCalledWith(2);
      expect(notificationService.clearPermanentFailureFlag).toHaveBeenCalledWith(2);
      expect(buttonInteraction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining(
            '✅ 관리자 공지 전송 완료, requested_by=admin#1234, total=2, success=1, failed=1, deactivated=1',
          ),
        }),
      );
    });

    it('reports when dispatch services are unavailable', async () => {
      const webhookService = { findAll: jest.fn().mockResolvedValue(webhooks) };
      const get = jest
        .fn()
        .mockReturnValueOnce(webhookService) // cmdNoticeBatch
        .mockReturnValueOnce(webhookService) // dispatch webhookService
        .mockReturnValueOnce(undefined); // dispatch notificationService
      const { service, token } = await createServiceWithDraft(get);

      const buttonInteraction = createButtonInteraction(
        `${PREFIX}:confirm_send:${token}`,
      );
      await service.executeComponentInteraction(buttonInteraction);

      expect(buttonInteraction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({
          content:
            '❌ 공지 전송에 필요한 서비스(WebhookService/NotificationService)가 준비되지 않았습니다.',
        }),
      );
    });

    it('reports when all webhooks have disappeared before dispatch', async () => {
      const webhookService = {
        findAll: jest
          .fn()
          .mockResolvedValueOnce(webhooks) // cmdNoticeBatch
          .mockResolvedValueOnce([]), // dispatch
      };
      const notificationService = {
        sendDiscordAdminAnnouncementBatch: jest.fn(),
        clearPermanentFailureFlag: jest.fn(),
      };
      const get = jest
        .fn()
        .mockReturnValueOnce(webhookService) // cmdNoticeBatch
        .mockReturnValueOnce(webhookService) // dispatch webhookService
        .mockReturnValueOnce(notificationService); // dispatch notificationService
      const { service, token } = await createServiceWithDraft(get);

      const buttonInteraction = createButtonInteraction(
        `${PREFIX}:confirm_send:${token}`,
      );
      await service.executeComponentInteraction(buttonInteraction);

      expect(notificationService.sendDiscordAdminAnnouncementBatch).not.toHaveBeenCalled();
      expect(buttonInteraction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'ℹ️ 활성화된 웹훅이 없어 공지를 전송하지 않았습니다.',
        }),
      );
    });

    it('replies with an error when dispatch throws', async () => {
      const webhookService = { findAll: jest.fn().mockResolvedValue(webhooks) };
      const notificationService = {
        sendDiscordAdminAnnouncementBatch: jest
          .fn()
          .mockRejectedValue(new Error('rate limited')),
        clearPermanentFailureFlag: jest.fn(),
      };
      const get = jest
        .fn()
        .mockReturnValueOnce(webhookService) // cmdNoticeBatch
        .mockReturnValueOnce(webhookService) // dispatch webhookService
        .mockReturnValueOnce(notificationService); // dispatch notificationService
      const { service, token } = await createServiceWithDraft(get);

      const buttonInteraction = createButtonInteraction(
        `${PREFIX}:confirm_send:${token}`,
      );
      await service.executeComponentInteraction(buttonInteraction);

      expect(buttonInteraction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '❌ 공지 전송 중 오류가 발생했습니다: rate limited',
        }),
      );
    });
  });
});