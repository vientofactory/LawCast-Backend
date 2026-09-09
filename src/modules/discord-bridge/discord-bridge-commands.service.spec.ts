import { DiscordBridgeCommandsService } from './discord-bridge-commands.service';

describe('DiscordBridgeCommandsService', () => {
  function createService() {
    const operationsCommands = {
      execute: jest.fn().mockResolvedValue(false),
    };
    const adminAnnouncementCommands = {
      executeCommand: jest.fn().mockResolvedValue(false),
      executeComponentInteraction: jest.fn().mockResolvedValue(false),
    };
    const discussionsCommands = {
      executeCommand: jest.fn().mockResolvedValue(false),
      executeComponentInteraction: jest.fn().mockResolvedValue(false),
    };
    const service = new DiscordBridgeCommandsService(
      operationsCommands as any,
      adminAnnouncementCommands as any,
      discussionsCommands as any,
    );
    return {
      service,
      operationsCommands,
      adminAnnouncementCommands,
      discussionsCommands,
    };
  }

  describe('execute', () => {
    it('short-circuits when operationsCommands handles the command', async () => {
      const {
        service,
        operationsCommands,
        discussionsCommands,
        adminAnnouncementCommands,
      } = createService();
      operationsCommands.execute.mockResolvedValueOnce(true);
      const interaction = { commandName: 'status' } as any;
      const ctx = { currentLogLevel: 2 } as any;

      await service.execute(interaction, ctx);

      expect(operationsCommands.execute).toHaveBeenCalledWith(interaction, ctx);
      expect(discussionsCommands.executeCommand).not.toHaveBeenCalled();
      expect(adminAnnouncementCommands.executeCommand).not.toHaveBeenCalled();
    });

    it('routes to discussionsCommands when operations does not handle it', async () => {
      const {
        service,
        operationsCommands,
        discussionsCommands,
        adminAnnouncementCommands,
      } = createService();
      discussionsCommands.executeCommand.mockResolvedValueOnce(true);
      const interaction = { commandName: 'discussion-admin' } as any;
      const ctx = { currentLogLevel: 2 } as any;

      await service.execute(interaction, ctx);

      expect(operationsCommands.execute).toHaveBeenCalledWith(interaction, ctx);
      expect(discussionsCommands.executeCommand).toHaveBeenCalledWith(
        interaction,
      );
      expect(adminAnnouncementCommands.executeCommand).not.toHaveBeenCalled();
    });

    it('falls back to adminAnnouncementCommands when nothing else handles it', async () => {
      const {
        service,
        operationsCommands,
        discussionsCommands,
        adminAnnouncementCommands,
      } = createService();
      const interaction = { commandName: 'notice-batch' } as any;
      const ctx = { currentLogLevel: 2 } as any;

      await service.execute(interaction, ctx);

      expect(operationsCommands.execute).toHaveBeenCalledWith(interaction, ctx);
      expect(discussionsCommands.executeCommand).toHaveBeenCalledWith(
        interaction,
      );
      expect(adminAnnouncementCommands.executeCommand).toHaveBeenCalledWith(
        interaction,
      );
    });
  });

  describe('executeComponentInteraction', () => {
    it('returns true when discussionsCommands handles the component', async () => {
      const { service, discussionsCommands, adminAnnouncementCommands } =
        createService();
      discussionsCommands.executeComponentInteraction.mockResolvedValueOnce(
        true,
      );
      const interaction = { customId: 'da:page:1:-' } as any;

      await expect(
        service.executeComponentInteraction(interaction),
      ).resolves.toBe(true);

      expect(
        discussionsCommands.executeComponentInteraction,
      ).toHaveBeenCalledWith(interaction);
      expect(
        adminAnnouncementCommands.executeComponentInteraction,
      ).not.toHaveBeenCalled();
    });

    it('falls back to adminAnnouncementCommands and returns its result', async () => {
      const { service, discussionsCommands, adminAnnouncementCommands } =
        createService();
      adminAnnouncementCommands.executeComponentInteraction.mockResolvedValueOnce(
        true,
      );
      const interaction = { customId: 'admin_announcement:cancel:abc' } as any;

      await expect(
        service.executeComponentInteraction(interaction),
      ).resolves.toBe(true);

      expect(
        discussionsCommands.executeComponentInteraction,
      ).toHaveBeenCalledWith(interaction);
      expect(
        adminAnnouncementCommands.executeComponentInteraction,
      ).toHaveBeenCalledWith(interaction);
    });

    it('returns false when no sub-service handles the component', async () => {
      const { service } = createService();
      const interaction = { customId: 'unrelated:action' } as any;

      await expect(
        service.executeComponentInteraction(interaction),
      ).resolves.toBe(false);
    });
  });
});
