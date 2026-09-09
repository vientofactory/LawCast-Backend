import {
  Collection,
  Client,
  REST,
  Routes,
  Events,
  MessageFlags,
} from 'discord.js';
import { DiscordBridgeService } from './discord-bridge.service';
import { BridgeLogLevel } from './discord-bridge.types';

jest.mock('discord.js', () => {
  const actual = jest.requireActual('discord.js');
  return {
    ...actual,
    Client: jest.fn(),
    REST: jest.fn(),
  };
});

const mockClient = {
  once: jest.fn(),
  on: jest.fn(),
  login: jest.fn().mockResolvedValue(undefined),
  destroy: jest.fn().mockResolvedValue(undefined),
  user: { id: 'bot-1', tag: 'bot#1234' },
  application: { id: 'app-1' },
  channels: { fetch: jest.fn() },
};

const restMock = {
  setToken: jest.fn().mockReturnThis(),
  put: jest.fn().mockResolvedValue(undefined),
};

describe('DiscordBridgeService', () => {
  function createConfigService(overrides: Record<string, unknown> = {}) {
    const defaults: Record<string, unknown> = {
      'discordBridge.enabled': true,
      'discordBridge.botToken': 'bot-token',
      'discordBridge.bridgeChannelId': 'bridge-channel',
      'discordBridge.logChannelId': 'log-channel',
      'discordBridge.logLevel': BridgeLogLevel.LOG,
      'discordBridge.adminUserIds': ['admin-1', 'admin-2'],
      'discordBridge.guildId': 'guild-1',
    };
    return {
      get: jest.fn((key: string) =>
        key in overrides ? overrides[key] : defaults[key],
      ),
    } as any;
  }

  function createService(configOverrides: Record<string, unknown> = {}): {
    service: DiscordBridgeService;
    configService: any;
    commandsService: {
      execute: jest.Mock;
      executeComponentInteraction: jest.Mock;
    };
  } {
    const configService = createConfigService(configOverrides);
    const commandsService = {
      execute: jest.fn().mockResolvedValue(undefined),
      executeComponentInteraction: jest.fn().mockResolvedValue(true),
    };
    const service = new DiscordBridgeService(
      configService,
      commandsService as any,
    );
    return { service, configService, commandsService };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  function makeReady(service: DiscordBridgeService): void {
    const readyHandler = mockClient.once.mock.calls.find(
      ([event]) => event === Events.ClientReady,
    )?.[1] as (client: unknown) => void;
    readyHandler({ user: { tag: 'bot#1234' }, application: { id: 'app-1' } });
  }

  function getInteractionHandler(): (interaction: unknown) => Promise<void> {
    const handler = mockClient.on.mock.calls.find(
      ([event]) => event === Events.InteractionCreate,
    )?.[1] as (interaction: unknown) => void;
    return async (interaction) => handler(interaction);
  }

  function createTextChannel() {
    return {
      isTextBased: () => true,
      send: jest.fn().mockResolvedValue(undefined),
      messages: { fetch: jest.fn().mockResolvedValue(new Collection()) },
    };
  }

  function createMessage(
    id: string,
    options: {
      authorId?: string;
      embeds?: Array<{ title?: string; footer?: { text?: string } }>;
      createdTimestamp?: number;
    } = {},
  ) {
    return {
      id,
      author: { id: options.authorId ?? 'bot-1' },
      embeds: options.embeds ?? [],
      createdTimestamp: options.createdTimestamp ?? 1000,
      edit: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (Client as unknown as jest.Mock).mockReturnValue(mockClient);
    (REST as unknown as jest.Mock).mockImplementation(() => restMock);
    mockClient.channels.fetch.mockResolvedValue(createTextChannel());
  });

  describe('constructor', () => {
    it('reads bridge configuration from the config service', () => {
      const { configService } = createService();
      expect(configService.get).toHaveBeenCalledWith('discordBridge.enabled');
      expect(configService.get).toHaveBeenCalledWith('discordBridge.botToken');
      expect(configService.get).toHaveBeenCalledWith(
        'discordBridge.bridgeChannelId',
      );
      expect(configService.get).toHaveBeenCalledWith(
        'discordBridge.logChannelId',
      );
      expect(configService.get).toHaveBeenCalledWith('discordBridge.logLevel');
      expect(configService.get).toHaveBeenCalledWith(
        'discordBridge.adminUserIds',
      );
      expect(configService.get).toHaveBeenCalledWith('discordBridge.guildId');
    });

    it('defaults to disabled when the enabled flag is missing', () => {
      const { service, commandsService } = createService({
        'discordBridge.enabled': undefined,
      });
      void service.onModuleInit();
      expect(Client).not.toHaveBeenCalled();
      expect(commandsService.execute).not.toHaveBeenCalled();
    });
  });

  describe('onModuleInit', () => {
    it('does nothing when the bridge is disabled', async () => {
      const { service } = createService({ 'discordBridge.enabled': false });
      await service.onModuleInit();
      expect(Client).not.toHaveBeenCalled();
      expect(mockClient.login).not.toHaveBeenCalled();
    });

    it('warns and skips startup when the bot token is missing', async () => {
      const { service } = createService({ 'discordBridge.botToken': '' });
      await service.onModuleInit();
      expect(Client).not.toHaveBeenCalled();
      expect(mockClient.login).not.toHaveBeenCalled();
    });

    it('creates a client, wires listeners, and logs in with the token', async () => {
      const { service } = createService();
      await service.onModuleInit();
      expect(Client).toHaveBeenCalledWith({ intents: [1] });
      expect(mockClient.once).toHaveBeenCalledWith(
        Events.ClientReady,
        expect.any(Function),
      );
      expect(mockClient.on).toHaveBeenCalledWith(
        Events.InteractionCreate,
        expect.any(Function),
      );
      expect(mockClient.on).toHaveBeenCalledWith(
        Events.Error,
        expect.any(Function),
      );
      expect(mockClient.login).toHaveBeenCalledWith('bot-token');
    });

    it('clears the client when login fails', async () => {
      mockClient.login.mockRejectedValueOnce(new Error('invalid token'));
      const { service } = createService();
      await service.onModuleInit();
      expect(mockClient.login).toHaveBeenCalled();
      // A subsequent destroy should not be attempted since the client was nulled
      await service.onModuleDestroy();
      expect(mockClient.destroy).not.toHaveBeenCalled();
    });

    it('registers slash commands to the guild when guildId is configured', async () => {
      const { service } = createService();
      await service.onModuleInit();
      makeReady(service);
      expect(restMock.setToken).toHaveBeenCalledWith('bot-token');
      expect(restMock.put).toHaveBeenCalledWith(
        Routes.applicationGuildCommands('app-1', 'guild-1'),
        expect.objectContaining({ body: expect.any(Array) }),
      );
    });

    it('registers slash commands globally when guildId is empty', async () => {
      const { service } = createService({ 'discordBridge.guildId': '' });
      await service.onModuleInit();
      makeReady(service);
      expect(restMock.put).toHaveBeenCalledWith(
        Routes.applicationCommands('app-1'),
        expect.objectContaining({ body: expect.any(Array) }),
      );
    });
  });

  describe('onModuleDestroy', () => {
    it('destroys the client and resets the ready state', async () => {
      const { service } = createService();
      await service.onModuleInit();
      makeReady(service);
      await service.onModuleDestroy();
      expect(mockClient.destroy).toHaveBeenCalledTimes(1);
    });

    it('does nothing when no client exists', async () => {
      const { service } = createService({ 'discordBridge.enabled': false });
      await service.onModuleDestroy();
      expect(mockClient.destroy).not.toHaveBeenCalled();
    });
  });

  describe('logEvent', () => {
    it('drops events when the bridge is disabled', async () => {
      const { service } = createService({ 'discordBridge.enabled': false });
      await service.logEvent(BridgeLogLevel.ERROR, 'ctx', 'msg');
      expect(mockClient.channels.fetch).not.toHaveBeenCalled();
    });

    it('drops events before the client is ready', async () => {
      const { service } = createService();
      await service.onModuleInit();
      await service.logEvent(BridgeLogLevel.ERROR, 'ctx', 'msg');
      expect(mockClient.channels.fetch).not.toHaveBeenCalled();
    });

    it('drops events above the configured log level threshold', async () => {
      const { service } = createService();
      await service.onModuleInit();
      makeReady(service);
      // current level is LOG(2); DEBUG(3) is above and must be dropped
      await service.logEvent(BridgeLogLevel.DEBUG, 'ctx', 'msg');
      expect(mockClient.channels.fetch).not.toHaveBeenCalled();
    });

    it('sends a structured embed to the log channel', async () => {
      const { service } = createService();
      await service.onModuleInit();
      makeReady(service);
      const channel = createTextChannel();
      mockClient.channels.fetch.mockResolvedValue(channel);

      await service.logEvent(
        BridgeLogLevel.WARN,
        'crawling',
        'something failed',
        {
          attempts: 3,
        },
      );

      expect(mockClient.channels.fetch).toHaveBeenCalledWith('log-channel');
      expect(channel.send).toHaveBeenCalledTimes(1);
      const embed = channel.send.mock.calls[0][0].embeds[0];
      expect(embed.data.title).toBe('🟡 [WARN] crawling');
      expect(embed.data.description).toBe('something failed');
      expect(embed.data.color).toBe(0xffa500);
      expect(embed.data.fields[0].name).toBe('Details');
      expect(embed.data.fields[0].value).toContain('"attempts": 3');
    });

    it('does not send when the fetched channel is not text based', async () => {
      const { service } = createService();
      await service.onModuleInit();
      makeReady(service);
      mockClient.channels.fetch.mockResolvedValue({ isTextBased: () => false });

      await service.logEvent(BridgeLogLevel.WARN, 'ctx', 'msg');
      expect(mockClient.channels.fetch).toHaveBeenCalledWith('log-channel');
    });

    it('does not throw when sending fails', async () => {
      const { service } = createService();
      await service.onModuleInit();
      makeReady(service);
      const channel = createTextChannel();
      channel.send.mockRejectedValueOnce(new Error('network down'));
      mockClient.channels.fetch.mockResolvedValue(channel);

      await expect(
        service.logEvent(BridgeLogLevel.ERROR, 'ctx', 'msg'),
      ).resolves.toBeUndefined();
    });
  });

  describe('sendCriticalAlert', () => {
    it('bypasses the log level threshold and always sends', async () => {
      const { service } = createService();
      await service.onModuleInit();
      makeReady(service);
      const channel = createTextChannel();
      mockClient.channels.fetch.mockResolvedValue(channel);

      await service.sendCriticalAlert('uncaughtException', 'process crashed');

      const embed = channel.send.mock.calls[0][0].embeds[0];
      expect(embed.data.title).toBe('💀 [FATAL] uncaughtException');
      expect(embed.data.color).toBe(0xcc0000);
    });

    it('includes stack and cause for Error inputs', async () => {
      const { service } = createService();
      await service.onModuleInit();
      makeReady(service);
      const channel = createTextChannel();
      mockClient.channels.fetch.mockResolvedValue(channel);

      const error = new Error('disk full');
      (error as Error & { cause?: unknown }).cause = new Error('root cause');
      error.stack = 'stack-trace-line-1';
      await service.sendCriticalAlert('db-mirror', 'failed', error);

      const field = channel.send.mock.calls[0][0].embeds[0].data.fields[0];
      expect(field.value).toContain('stack-trace-line-1');
      expect(field.value).toContain('root cause');
    });

    it('includes the reason string for non-Error inputs', async () => {
      const { service } = createService();
      await service.onModuleInit();
      makeReady(service);
      const channel = createTextChannel();
      mockClient.channels.fetch.mockResolvedValue(channel);

      await service.sendCriticalAlert('ctx', 'boom', 'oops-value');

      const field = channel.send.mock.calls[0][0].embeds[0].data.fields[0];
      expect(field.value).toContain('oops-value');
    });

    it('never throws, even when sending fails', async () => {
      const { service } = createService();
      await service.onModuleInit();
      makeReady(service);
      const channel = createTextChannel();
      channel.send.mockRejectedValueOnce(new Error('boom'));
      mockClient.channels.fetch.mockResolvedValue(channel);

      await expect(
        service.sendCriticalAlert('ctx', 'msg', new Error('x')),
      ).resolves.toBeUndefined();
    });
  });

  describe('upsertDbMirrorAnnouncement', () => {
    const params = {
      channelId: 'mirror-channel',
      shareUrl: 'https://drive.example.com/dump',
      dumpedAt: new Date('2026-01-01T00:00:00.000Z'),
      dumpFileName: 'lawcast-2026-01-01.db',
      folderId: 'folder-1',
      fileId: 'file-1',
    };

    it('warns and skips when the bridge is disabled', async () => {
      const { service } = createService({ 'discordBridge.enabled': false });
      await service.upsertDbMirrorAnnouncement(params);
      expect(mockClient.channels.fetch).not.toHaveBeenCalled();
    });

    it('warns and skips when the client is not ready', async () => {
      const { service } = createService();
      await service.onModuleInit();
      await service.upsertDbMirrorAnnouncement(params);
      expect(mockClient.channels.fetch).not.toHaveBeenCalled();
    });

    it('warns and skips when the channelId is empty', async () => {
      const { service } = createService();
      await service.onModuleInit();
      makeReady(service);
      await service.upsertDbMirrorAnnouncement({ ...params, channelId: '' });
      expect(mockClient.channels.fetch).not.toHaveBeenCalled();
    });

    it('sends a new announcement when no previous one exists', async () => {
      const { service } = createService();
      await service.onModuleInit();
      makeReady(service);
      const channel = createTextChannel();
      mockClient.channels.fetch.mockResolvedValue(channel);

      await service.upsertDbMirrorAnnouncement(params);

      expect(mockClient.channels.fetch).toHaveBeenCalledWith('mirror-channel');
      expect(channel.send).toHaveBeenCalledTimes(1);
      const embed = channel.send.mock.calls[0][0].embeds[0];
      expect(embed.data.title).toBe('LawCast Database Mirror');
      expect(embed.data.footer.text).toBe('Database Mirror Announcement');
      expect(embed.data.fields[0].value).toBe(
        '[Download Dump](https://drive.example.com/dump)',
      );
      expect(channel.messages.fetch).toHaveBeenCalled();
    });

    it('edits the newest existing announcement and deletes stale ones', async () => {
      const { service } = createService();
      await service.onModuleInit();
      makeReady(service);
      const channel = createTextChannel();
      mockClient.channels.fetch.mockResolvedValue(channel);

      const stale1 = createMessage('m1', {
        embeds: [{ title: 'LawCast Database Mirror' }],
        createdTimestamp: 100,
      });
      const newest = createMessage('m2', {
        embeds: [{ footer: { text: 'Database Mirror Announcement' } }],
        createdTimestamp: 300,
      });
      const stale2 = createMessage('m3', {
        embeds: [{ footer: { text: 'LawCast DB Mirror Announcement' } }],
        createdTimestamp: 200,
      });
      const otherBot = createMessage('m4', {
        authorId: 'someone-else',
        embeds: [{ title: 'LawCast Database Mirror' }],
        createdTimestamp: 400,
      });
      channel.messages.fetch
        .mockResolvedValueOnce(
          new Collection([
            ['m1', stale1],
            ['m2', newest],
            ['m3', stale2],
            ['m4', otherBot],
          ]),
        )
        .mockResolvedValue(new Collection());

      await service.upsertDbMirrorAnnouncement(params);

      expect(newest.edit).toHaveBeenCalledWith(
        expect.objectContaining({ embeds: expect.any(Array) }),
      );
      expect(stale1.delete).toHaveBeenCalledTimes(1);
      expect(stale2.delete).toHaveBeenCalledTimes(1);
      expect(otherBot.delete).not.toHaveBeenCalled();
      expect(channel.send).not.toHaveBeenCalled();
    });

    it('does not throw when the channel fetch fails', async () => {
      const { service } = createService();
      await service.onModuleInit();
      makeReady(service);
      mockClient.channels.fetch.mockRejectedValueOnce(
        new Error('missing channel'),
      );

      await expect(
        service.upsertDbMirrorAnnouncement(params),
      ).resolves.toBeUndefined();
    });
  });

  describe('upsertDbMirrorErrorAnnouncement', () => {
    const params = {
      channelId: 'mirror-channel',
      failedAt: new Date('2026-01-01T01:00:00.000Z'),
      stage: 'upload' as const,
      errorMessage: 'gdrive quota exceeded',
      dumpFileName: 'lawcast-2026-01-01.db',
    };

    it('sends a new error announcement embed', async () => {
      const { service } = createService();
      await service.onModuleInit();
      makeReady(service);
      const channel = createTextChannel();
      mockClient.channels.fetch.mockResolvedValue(channel);

      await service.upsertDbMirrorErrorAnnouncement(params);

      expect(channel.send).toHaveBeenCalledTimes(1);
      const embed = channel.send.mock.calls[0][0].embeds[0];
      expect(embed.data.title).toBe('LawCast Database Mirror Error');
      expect(embed.data.color).toBe(0xef4444);
      expect(embed.data.fields[1].value).toBe('File Upload');
      expect(embed.data.fields[2].value).toBe('gdrive quota exceeded');
      expect(embed.data.fields[3].value).toBe('lawcast-2026-01-01.db');
    });

    it('edits the existing error announcement instead of sending a duplicate', async () => {
      const { service } = createService();
      await service.onModuleInit();
      makeReady(service);
      const channel = createTextChannel();
      mockClient.channels.fetch.mockResolvedValue(channel);

      const existing = createMessage('e1', {
        embeds: [{ footer: { text: 'Database Mirror Error Announcement' } }],
        createdTimestamp: 100,
      });
      channel.messages.fetch
        .mockResolvedValueOnce(
          new Collection([
            ['e1', existing],
            [
              'e2',
              createMessage('e2', {
                embeds: [{ title: 'LawCast Database Mirror Error' }],
                createdTimestamp: 50,
              }),
            ],
          ]),
        )
        .mockResolvedValue(new Collection());

      await service.upsertDbMirrorErrorAnnouncement(params);

      expect(existing.edit).toHaveBeenCalledTimes(1);
      expect(channel.send).not.toHaveBeenCalled();
    });
  });

  describe('clearDbMirrorErrorAnnouncements', () => {
    it('deletes all error announcements posted by the bot', async () => {
      const { service } = createService();
      await service.onModuleInit();
      makeReady(service);
      const channel = createTextChannel();
      mockClient.channels.fetch.mockResolvedValue(channel);

      const msg1 = createMessage('x1', {
        embeds: [{ footer: { text: 'Database Mirror Error Announcement' } }],
      });
      const msg2 = createMessage('x2', {
        embeds: [{ title: 'LawCast Database Mirror Error' }],
      });
      const unrelated = createMessage('x3', {
        embeds: [{ title: 'Something else' }],
      });
      channel.messages.fetch
        .mockResolvedValueOnce(
          new Collection([
            ['x1', msg1],
            ['x2', msg2],
            ['x3', unrelated],
          ]),
        )
        .mockResolvedValue(new Collection());

      await service.clearDbMirrorErrorAnnouncements('mirror-channel');

      expect(msg1.delete).toHaveBeenCalledTimes(1);
      expect(msg2.delete).toHaveBeenCalledTimes(1);
      expect(unrelated.delete).not.toHaveBeenCalled();
    });

    it('does nothing when there are no error announcements', async () => {
      const { service } = createService();
      await service.onModuleInit();
      makeReady(service);
      const channel = createTextChannel();
      mockClient.channels.fetch.mockResolvedValue(channel);

      await service.clearDbMirrorErrorAnnouncements('mirror-channel');
      expect(channel.messages.fetch).toHaveBeenCalled();
    });
  });

  describe('handleInteraction', () => {
    it('ignores interactions from non-admin users', async () => {
      const { service, commandsService } = createService();
      await service.onModuleInit();
      const handler = getInteractionHandler();

      await handler({
        isChatInputCommand: () => true,
        channelId: 'bridge-channel',
        user: { id: 'not-admin' },
      });

      expect(commandsService.execute).not.toHaveBeenCalled();
    });

    it('ignores interactions from other channels', async () => {
      const { service, commandsService } = createService();
      await service.onModuleInit();
      const handler = getInteractionHandler();

      await handler({
        isChatInputCommand: () => true,
        channelId: 'other-channel',
        user: { id: 'admin-1' },
      });

      expect(commandsService.execute).not.toHaveBeenCalled();
    });

    it('routes chat input commands with a command context', async () => {
      const { service, commandsService } = createService();
      await service.onModuleInit();
      const handler = getInteractionHandler();
      const interaction = {
        isChatInputCommand: () => true,
        channelId: 'bridge-channel',
        user: { id: 'admin-1' },
      };

      await handler(interaction);

      expect(commandsService.execute).toHaveBeenCalledWith(
        interaction,
        expect.objectContaining({
          currentLogLevel: BridgeLogLevel.LOG,
          adminCount: 2,
        }),
      );
    });

    it('routes component interactions to executeComponentInteraction', async () => {
      const { service, commandsService } = createService();
      await service.onModuleInit();
      const handler = getInteractionHandler();
      const interaction = {
        isChatInputCommand: () => false,
        isButton: () => true,
        channelId: 'bridge-channel',
        user: { id: 'admin-1' },
      };

      await handler(interaction);

      expect(commandsService.executeComponentInteraction).toHaveBeenCalledWith(
        interaction,
      );
    });

    it('replies with an ephemeral error when a command throws', async () => {
      const { service, commandsService } = createService();
      commandsService.execute.mockRejectedValueOnce(new Error('boom'));
      await service.onModuleInit();
      const handler = getInteractionHandler();
      const reply = jest.fn().mockResolvedValue(undefined);
      const interaction = {
        isChatInputCommand: () => true,
        channelId: 'bridge-channel',
        user: { id: 'admin-1' },
        replied: false,
        deferred: false,
        reply,
      };

      await handler(interaction);

      expect(reply).toHaveBeenCalledWith({
        content: '❌ Command error: boom',
        flags: MessageFlags.Ephemeral,
      });
    });

    it('edits the reply when a deferred command throws', async () => {
      const { service, commandsService } = createService();
      commandsService.execute.mockRejectedValueOnce(new Error('boom'));
      await service.onModuleInit();
      const handler = getInteractionHandler();
      const editReply = jest.fn().mockResolvedValue(undefined);
      const interaction = {
        isChatInputCommand: () => true,
        channelId: 'bridge-channel',
        user: { id: 'admin-1' },
        replied: false,
        deferred: true,
        editReply,
      };

      await handler(interaction);

      expect(editReply).toHaveBeenCalledWith('❌ Command error: boom');
    });

    it('lets commands change the log level through the context', async () => {
      const { service, commandsService } = createService();
      commandsService.execute.mockImplementationOnce(
        async (
          _i: unknown,
          ctx: { setLogLevel: (l: BridgeLogLevel) => void },
        ) => {
          ctx.setLogLevel(BridgeLogLevel.DEBUG);
        },
      );
      await service.onModuleInit();
      makeReady(service);
      const handler = getInteractionHandler();
      const channel = createTextChannel();
      mockClient.channels.fetch.mockResolvedValue(channel);

      await handler({
        isChatInputCommand: () => true,
        channelId: 'bridge-channel',
        user: { id: 'admin-1' },
      });

      // After the command set the level to DEBUG, a DEBUG log event must pass
      await service.logEvent(BridgeLogLevel.DEBUG, 'ctx', 'debug message');
      expect(channel.send).toHaveBeenCalledTimes(1);
    });
  });
});
