import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Client,
  GatewayIntentBits,
  TextChannel,
  Message,
  EmbedBuilder,
  Events,
  REST,
  Routes,
  ApplicationCommandOptionType,
  Interaction,
  MessageFlags,
} from 'discord.js';
import {
  BridgeLogLevel,
  BRIDGE_LOG_LEVEL_LABELS,
  BRIDGE_LOG_LEVEL_COLORS,
  BRIDGE_LOG_LEVEL_ICONS,
} from './discord-bridge.types';
import { DiscordBridgeCommandsService } from './discord-bridge-commands.service';
import { LoggerUtils } from '../../utils/logger.utils';

const SLASH_COMMAND_DEFINITIONS = [
  { name: 'status', description: 'Server uptime, memory, and runtime info' },
  { name: 'health', description: 'Redis & Ollama health check' },
  { name: 'stats', description: 'Aggregate runtime statistics' },
  { name: 'cache', description: 'Redis cache status' },
  { name: 'crawl', description: 'Trigger a manual crawl cycle' },
  {
    name: 'notice-batch',
    description: 'Compose and broadcast an admin announcement to all webhooks',
    options: [
      {
        name: 'dry_run',
        description: 'Run validation flow without actually sending',
        type: ApplicationCommandOptionType.Boolean,
        required: false,
      },
    ],
  },
  { name: 'batch-history', description: 'Recent batch job history' },
  { name: 'webhooks', description: 'Webhook statistics' },
  {
    name: 'locks',
    description: 'Lock/phase execution state and cron layout for debugging',
  },
  {
    name: 'browser-lease',
    description: 'Browser launch guard status (concurrency/lock/cooldown)',
  },
  {
    name: 'mirror-upload',
    description: 'Manually trigger a database dump upload for testing',
  },
  {
    name: 'loglevel',
    description: 'Get or set the log level for the log channel',
    options: [
      {
        name: 'level',
        description: 'New log level to apply',
        type: ApplicationCommandOptionType.String,
        required: false,
        choices: [
          { name: 'ERROR', value: 'error' },
          { name: 'WARN', value: 'warn' },
          { name: 'LOG', value: 'log' },
          { name: 'DEBUG', value: 'debug' },
          { name: 'VERBOSE', value: 'verbose' },
        ],
      },
    ],
  },
] as const;

@Injectable()
export class DiscordBridgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = LoggerUtils.getContextLogger(
    DiscordBridgeService.name,
  );
  private client: Client | null = null;
  private isReady = false;
  private currentLogLevel: BridgeLogLevel;

  private readonly enabled: boolean;
  private readonly botToken: string;
  private readonly bridgeChannelId: string;
  private readonly logChannelId: string;
  private readonly adminUserIds: Set<string>;
  private readonly guildId: string;

  // Markers for identifying DB mirror announcement messages
  private readonly DB_MIRROR_ANNOUNCEMENT_FOOTER =
    'Database Mirror Announcement';
  private readonly DB_MIRROR_ANNOUNCEMENT_LEGACY_FOOTER =
    'LawCast DB Mirror Announcement';
  private readonly DB_MIRROR_ANNOUNCEMENT_TITLE = 'LawCast Database Mirror';

  constructor(
    private readonly configService: ConfigService,
    private readonly commandsService: DiscordBridgeCommandsService,
  ) {
    this.enabled =
      this.configService.get<boolean>('discordBridge.enabled') ?? false;
    this.botToken =
      this.configService.get<string>('discordBridge.botToken') ?? '';
    this.bridgeChannelId =
      this.configService.get<string>('discordBridge.bridgeChannelId') ?? '';
    this.logChannelId =
      this.configService.get<string>('discordBridge.logChannelId') ?? '';
    this.currentLogLevel =
      this.configService.get<BridgeLogLevel>('discordBridge.logLevel') ??
      BridgeLogLevel.LOG;
    const adminIds =
      this.configService.get<string[]>('discordBridge.adminUserIds') ?? [];
    this.adminUserIds = new Set(adminIds);
    this.guildId =
      this.configService.get<string>('discordBridge.guildId') ?? '';
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('Discord debug bridge is disabled');
      return;
    }
    if (!this.botToken) {
      this.logger.warn(
        'DISCORD_BRIDGE_BOT_TOKEN is not set - bridge will not start',
      );
      return;
    }

    this.client = new Client({
      intents: [GatewayIntentBits.Guilds],
    });

    this.client.once(Events.ClientReady, (readyClient) => {
      this.isReady = true;
      this.logger.log(
        `Discord debug bridge connected as ${readyClient.user.tag}`,
      );
      void this.registerSlashCommands(readyClient);
    });

    this.client.on(Events.InteractionCreate, (interaction) => {
      void this.handleInteraction(interaction);
    });

    this.client.on(Events.Error, (error) => {
      this.logger.error('Discord client error:', error);
    });

    try {
      await this.client.login(this.botToken);
    } catch (error) {
      this.logger.error(
        'Failed to connect Discord debug bridge:',
        (error as Error).message,
      );
      this.client = null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      this.isReady = false;
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Send a structured log event to the Discord log channel.
   * Filtered by the configured log level - events above the threshold are silently dropped.
   */
  async logEvent(
    level: BridgeLogLevel,
    context: string,
    message: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.enabled || !this.isReady || !this.client || !this.logChannelId)
      return;
    if (level > this.currentLogLevel) return;

    try {
      const channel = await this.client.channels.fetch(this.logChannelId);
      if (!channel?.isTextBased()) return;
      const embed = this.buildLogEmbed(level, context, message, data);
      await (channel as TextChannel).send({ embeds: [embed] });
    } catch (error) {
      this.logger.error(
        'Failed to send log to Discord log channel:',
        (error as Error).message,
      );
    }
  }

  /**
   * Sends a critical process-level alert to the Discord log channel,
   * bypassing the configured log level filter entirely.
   * Intended for use in Node.js global error handlers (uncaughtException,
   * unhandledRejection) where the normal log level threshold should not apply.
   * This method is guaranteed not to throw.
   */
  async sendCriticalAlert(
    context: string,
    message: string,
    error?: unknown,
  ): Promise<void> {
    if (!this.enabled || !this.isReady || !this.client || !this.logChannelId)
      return;

    try {
      const channel = await this.client.channels.fetch(this.logChannelId);
      if (!channel?.isTextBased()) return;

      const data: Record<string, unknown> = {};
      if (error instanceof Error) {
        if (error.stack) data['stack'] = error.stack;
        const cause = (error as Error & { cause?: unknown }).cause;
        if (cause !== undefined) data['cause'] = String(cause);
      } else if (error !== undefined) {
        data['reason'] = String(error);
      }

      const embed = new EmbedBuilder()
        .setColor(0xcc0000)
        .setTitle(`💀 [FATAL] ${context}`)
        .setDescription(message)
        .setTimestamp()
        .setFooter({ text: 'LawCast Debug Bridge' });

      if (Object.keys(data).length > 0) {
        const raw = JSON.stringify(data, null, 2);
        const truncated = raw.length > 950 ? raw.slice(0, 947) + '…' : raw;
        embed.addFields({
          name: 'Details',
          value: `\`\`\`json\n${truncated}\n\`\`\``,
        });
      }

      await (channel as TextChannel).send({ embeds: [embed] });
    } catch {
      // Intentionally swallow - we are already inside an error handler
    }
  }

  /**
   * Upserts a DB mirror announcement embed in the target channel.
   * If a previous announcement sent by this bot exists, edit it in place.
   * Otherwise send a new message.
   */
  async upsertDbMirrorAnnouncement(params: {
    channelId: string;
    shareUrl: string;
    dumpedAt: Date;
    dumpFileName: string;
    folderId: string;
    fileId: string;
  }): Promise<void> {
    if (!this.enabled) {
      this.logger.warn(
        'Skipping DB mirror announcement upsert because Discord bridge is disabled.',
      );
      return;
    }

    if (!this.isReady || !this.client) {
      this.logger.warn(
        'Skipping DB mirror announcement upsert because Discord bridge client is not ready yet.',
      );
      return;
    }

    if (!params.channelId) {
      this.logger.warn(
        'Skipping DB mirror announcement upsert because target channelId is empty.',
      );
      return;
    }

    try {
      const channel = await this.client.channels.fetch(params.channelId);
      if (!channel?.isTextBased()) {
        return;
      }

      const textChannel = channel as TextChannel;
      const embed = this.buildDbMirrorAnnouncementEmbed(params);
      const existingMessages =
        await this.findExistingMirrorAnnouncements(textChannel);
      const primary = existingMessages[0] ?? null;

      if (primary) {
        await primary.edit({ embeds: [embed] });
      } else {
        await textChannel.send({ embeds: [embed] });
      }

      if (existingMessages.length > 1) {
        const staleMessages = existingMessages.slice(1);
        for (const staleMessage of staleMessages) {
          await staleMessage.delete().catch(() => {});
        }
      }
    } catch (error) {
      this.logger.error(
        'Failed to upsert DB mirror announcement:',
        (error as Error).message,
      );
    }
  }

  // ─── Embed builder ────────────────────────────────────────────────────────

  private buildLogEmbed(
    level: BridgeLogLevel,
    context: string,
    message: string,
    data?: Record<string, unknown>,
  ): EmbedBuilder {
    const icon = BRIDGE_LOG_LEVEL_ICONS[level];
    const label = BRIDGE_LOG_LEVEL_LABELS[level];
    const color = BRIDGE_LOG_LEVEL_COLORS[level];

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(`${icon} [${label}] ${context}`)
      .setDescription(message)
      .setTimestamp()
      .setFooter({ text: 'LawCast Debug Bridge' });

    if (data && Object.keys(data).length > 0) {
      const raw = JSON.stringify(data, null, 2);
      const truncated = raw.length > 950 ? raw.slice(0, 947) + '…' : raw;
      embed.addFields({
        name: 'Details',
        value: `\`\`\`json\n${truncated}\n\`\`\``,
      });
    }

    return embed;
  }

  private buildDbMirrorAnnouncementEmbed(params: {
    shareUrl: string;
    dumpedAt: Date;
    dumpFileName: string;
    folderId: string;
    fileId: string;
  }): EmbedBuilder {
    return new EmbedBuilder()
      .setColor(0x10b981)
      .setTitle(this.DB_MIRROR_ANNOUNCEMENT_TITLE)
      .setDescription('최신 법률안 스냅샷/변경기록 DB 덤프 링크입니다.')
      .addFields(
        {
          name: 'Latest Dump Link',
          value: `[Download Dump](${params.shareUrl})`,
        },
        {
          name: 'Updated At (UTC)',
          value: params.dumpedAt.toISOString(),
          inline: true,
        },
        {
          name: 'Dump File',
          value: params.dumpFileName,
          inline: true,
        },
        {
          name: 'Reference',
          value: `folderId=${params.folderId}, fileId=${params.fileId}`,
        },
      )
      .setTimestamp(params.dumpedAt)
      .setFooter({ text: this.DB_MIRROR_ANNOUNCEMENT_FOOTER });
  }

  private async findExistingMirrorAnnouncements(
    channel: TextChannel,
  ): Promise<Message[]> {
    const botUserId = this.client?.user?.id;
    if (!botUserId) {
      return [];
    }

    const matchedMessages: Message[] = [];

    let before: string | undefined;
    const maxScanBatches = 6;
    const pageSize = 50;

    for (let batch = 0; batch < maxScanBatches; batch += 1) {
      const messages = await channel.messages.fetch({
        limit: pageSize,
        ...(before ? { before } : {}),
      });

      if (messages.size === 0) {
        break;
      }

      for (const message of messages.values()) {
        if (message.author.id !== botUserId) {
          continue;
        }

        const hasMarker = message.embeds.some((embed) => {
          const footer = embed.footer?.text ?? '';
          const title = embed.title ?? '';
          const footerMatched =
            footer === this.DB_MIRROR_ANNOUNCEMENT_FOOTER ||
            footer === this.DB_MIRROR_ANNOUNCEMENT_LEGACY_FOOTER;
          const titleMatched = title === this.DB_MIRROR_ANNOUNCEMENT_TITLE;
          return footerMatched || titleMatched;
        });

        if (hasMarker) {
          matchedMessages.push(message);
        }
      }

      before = messages.last()?.id;
      if (!before) {
        break;
      }
    }

    return matchedMessages.sort(
      (a, b) => b.createdTimestamp - a.createdTimestamp,
    );
  }

  // ─── Slash command registration ────────────────────────────────────────────

  private async registerSlashCommands(client: Client<true>): Promise<void> {
    const rest = new REST().setToken(this.botToken);
    const appId = client.application.id;
    try {
      if (this.guildId) {
        await rest.put(Routes.applicationGuildCommands(appId, this.guildId), {
          body: SLASH_COMMAND_DEFINITIONS,
        });
        this.logger.log(`Slash commands registered to guild ${this.guildId}`);
      } else {
        await rest.put(Routes.applicationCommands(appId), {
          body: SLASH_COMMAND_DEFINITIONS,
        });
        this.logger.log(
          'Slash commands registered globally (may take up to 1 hour to propagate)',
        );
      }
    } catch (error) {
      this.logger.error(
        'Failed to register slash commands:',
        (error as Error).message,
      );
    }
  }

  // ─── Interaction handling ─────────────────────────────────────────────────

  private async handleInteraction(interaction: Interaction): Promise<void> {
    const isSupportedInteraction =
      interaction.isChatInputCommand() ||
      interaction.isButton() ||
      interaction.isModalSubmit();
    if (!isSupportedInteraction) return;

    if (this.bridgeChannelId && interaction.channelId !== this.bridgeChannelId)
      return;
    // Silently ignore non-admin users
    if (!this.adminUserIds.has(interaction.user.id)) return;

    if (!interaction.isChatInputCommand()) {
      try {
        await this.commandsService.executeComponentInteraction(interaction);
      } catch (error) {
        const msg = `❌ Interaction error: ${(error as Error).message}`;
        if (interaction.isRepliable()) {
          if (interaction.replied || interaction.deferred) {
            await interaction
              .followUp({ content: msg, flags: MessageFlags.Ephemeral })
              .catch(() => {});
          } else {
            await interaction
              .reply({ content: msg, flags: MessageFlags.Ephemeral })
              .catch(() => {});
          }
        }
      }
      return;
    }

    const ctx = {
      currentLogLevel: this.currentLogLevel,
      setLogLevel: (level: BridgeLogLevel) => {
        this.currentLogLevel = level;
      },
      adminCount: this.adminUserIds.size,
    };

    try {
      await this.commandsService.execute(interaction, ctx);
    } catch (error) {
      const msg = `❌ Command error: ${(error as Error).message}`;
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(msg).catch(() => {});
      } else {
        await interaction
          .reply({ content: msg, flags: MessageFlags.Ephemeral })
          .catch(() => {});
      }
    }
  }
}
