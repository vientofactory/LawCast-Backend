import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Client,
  GatewayIntentBits,
  TextChannel,
  EmbedBuilder,
  Events,
  REST,
  Routes,
  ApplicationCommandOptionType,
  Interaction,
} from 'discord.js';
import {
  BridgeLogLevel,
  BRIDGE_LOG_LEVEL_LABELS,
  BRIDGE_LOG_LEVEL_COLORS,
  BRIDGE_LOG_LEVEL_ICONS,
} from './discord-bridge.types';
import { DiscordBridgeCommandsService } from './discord-bridge-commands.service';

const SLASH_COMMAND_DEFINITIONS = [
  { name: 'status', description: 'Server uptime, memory, and runtime info' },
  { name: 'health', description: 'Redis & Ollama health check' },
  { name: 'stats', description: 'Aggregate runtime statistics' },
  { name: 'cache', description: 'Redis cache status' },
  { name: 'crawl', description: 'Trigger a manual crawl cycle' },
  { name: 'batch-history', description: 'Recent batch job history' },
  { name: 'webhooks', description: 'Webhook statistics' },
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
  private readonly logger = new Logger(DiscordBridgeService.name);
  private client: Client | null = null;
  private isReady = false;
  private currentLogLevel: BridgeLogLevel;

  private readonly enabled: boolean;
  private readonly botToken: string;
  private readonly bridgeChannelId: string;
  private readonly logChannelId: string;
  private readonly adminUserIds: Set<string>;
  private readonly guildId: string;

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
    if (!interaction.isChatInputCommand()) return;
    if (this.bridgeChannelId && interaction.channelId !== this.bridgeChannelId)
      return;
    // Silently ignore non-admin users
    if (!this.adminUserIds.has(interaction.user.id)) return;

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
          .reply({ content: msg, ephemeral: true })
          .catch(() => {});
      }
    }
  }
}
