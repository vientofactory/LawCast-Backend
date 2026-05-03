import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import {
  BridgeLogLevel,
  BRIDGE_LOG_LEVEL_LABELS,
  BridgeCommandContext,
} from './discord-bridge.types';

@Injectable()
export class DiscordBridgeCommandsService {
  constructor(private readonly moduleRef: ModuleRef) {}

  async execute(
    interaction: ChatInputCommandInteraction,
    ctx: BridgeCommandContext,
  ): Promise<void> {
    switch (interaction.commandName) {
      case 'status':
        await this.cmdStatus(interaction, ctx);
        break;
      case 'health':
        await this.cmdHealth(interaction);
        break;
      case 'stats':
        await this.cmdStats(interaction);
        break;
      case 'cache':
        await this.cmdCache(interaction);
        break;
      case 'crawl':
        await this.cmdCrawl(interaction);
        break;
      case 'batch-history':
        await this.cmdBatchHistory(interaction);
        break;
      case 'webhooks':
        await this.cmdWebhooks(interaction);
        break;
      case 'loglevel':
        await this.cmdLogLevel(interaction, ctx);
        break;
    }
  }

  // ─── Commands ─────────────────────────────────────────────────────────────

  private async cmdStatus(
    interaction: ChatInputCommandInteraction,
    ctx: BridgeCommandContext,
  ): Promise<void> {
    const uptime = process.uptime();
    const mem = process.memoryUsage();

    const fmtBytes = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;
    const fmtUptime = (s: number) => {
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = Math.floor(s % 60);
      return `${h}h ${m}m ${sec}s`;
    };

    const embed = new EmbedBuilder()
      .setColor(0x10b981)
      .setTitle('📊 Server Status')
      .addFields(
        { name: 'Uptime', value: fmtUptime(uptime), inline: true },
        {
          name: 'Node Env',
          value: process.env.NODE_ENV ?? 'unknown',
          inline: true,
        },
        { name: 'Node.js', value: process.version, inline: true },
        { name: 'RSS', value: fmtBytes(mem.rss), inline: true },
        { name: 'Heap Used', value: fmtBytes(mem.heapUsed), inline: true },
        { name: 'Heap Total', value: fmtBytes(mem.heapTotal), inline: true },
        {
          name: 'Bridge Log Level',
          value: BRIDGE_LOG_LEVEL_LABELS[ctx.currentLogLevel],
          inline: true,
        },
        {
          name: 'Admins',
          value: String(ctx.adminCount),
          inline: true,
        },
      )
      .setTimestamp()
      .setFooter({ text: 'LawCast Debug Bridge' });

    await interaction.reply({ embeds: [embed] }).catch(() => {});
  }

  private async cmdHealth(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const { HealthCheckService } =
      await import('../../services/health-check.service');
    const healthCheckService = this.moduleRef.get(HealthCheckService, {
      strict: false,
    });

    const health = await healthCheckService.getApiHealthPayload({
      nodeEnv: process.env.NODE_ENV,
    });

    const isHealthy = health.status === 'healthy';
    const embed = new EmbedBuilder()
      .setColor(isHealthy ? 0x10b981 : 0xff4444)
      .setTitle(isHealthy ? '✅ System Healthy' : '⚠️ System Degraded')
      .addFields({ name: 'Status', value: health.status, inline: true });

    if ('dependencies' in health) {
      const deps = (health as { dependencies: Record<string, string> })
        .dependencies;
      for (const [key, value] of Object.entries(deps)) {
        embed.addFields({
          name: key.charAt(0).toUpperCase() + key.slice(1),
          value: String(value),
          inline: true,
        });
      }
    }

    embed.setTimestamp().setFooter({ text: 'LawCast Debug Bridge' });
    await interaction.reply({ embeds: [embed] }).catch(() => {});
  }

  private async cmdStats(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const { RuntimeStatsService } =
      await import('../../services/runtime-stats.service');
    const { WebhookService } = await import('../../services/webhook.service');
    const { CrawlingService } = await import('../../services/crawling.service');
    const { BatchProcessingService } =
      await import('../../services/batch-processing.service');
    const { NoticeArchiveService } =
      await import('../../services/notice-archive.service');
    const { ArchiveSyncService } =
      await import('../../services/archive-sync.service');

    const runtimeStats = this.moduleRef.get(RuntimeStatsService, {
      strict: false,
    });
    const webhookSvc = this.moduleRef.get(WebhookService, { strict: false });
    const crawlingSvc = this.moduleRef.get(CrawlingService, { strict: false });
    const batchSvc = this.moduleRef.get(BatchProcessingService, {
      strict: false,
    });
    const archiveSvc = this.moduleRef.get(NoticeArchiveService, {
      strict: false,
    });
    const archiveSyncSvc = this.moduleRef.get(ArchiveSyncService, {
      strict: false,
    });

    const stats = await runtimeStats.getAggregatedStats(
      { nodeEnv: process.env.NODE_ENV },
      webhookSvc,
      crawlingSvc,
      batchSvc,
      archiveSvc,
      archiveSyncSvc,
    );

    const raw = JSON.stringify(stats, null, 2);
    const truncated = raw.length > 3800 ? raw.slice(0, 3797) + '…' : raw;

    const embed = new EmbedBuilder()
      .setColor(0x3b82f6)
      .setTitle('📈 Runtime Stats')
      .setDescription(`\`\`\`json\n${truncated}\n\`\`\``)
      .setTimestamp()
      .setFooter({ text: 'LawCast Debug Bridge' });

    await interaction.reply({ embeds: [embed] }).catch(() => {});
  }

  private async cmdCache(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const { CacheService } = await import('../../services/cache.service');
    const cacheService = this.moduleRef.get(CacheService, { strict: false });
    const info = await cacheService.getCacheInfo();

    const embed = new EmbedBuilder()
      .setColor(0x3b82f6)
      .setTitle('🗄️ Cache Status')
      .addFields(
        { name: 'Size', value: String(info.size), inline: true },
        { name: 'Max Size', value: String(info.maxSize), inline: true },
        {
          name: 'Initialized',
          value: String(info.isInitialized),
          inline: true,
        },
        {
          name: 'Last Updated',
          value: info.lastUpdated
            ? new Date(info.lastUpdated as string | number | Date).toISOString()
            : 'N/A',
          inline: false,
        },
      )
      .setTimestamp()
      .setFooter({ text: 'LawCast Debug Bridge' });

    await interaction.reply({ embeds: [embed] }).catch(() => {});
  }

  private async cmdCrawl(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    await interaction.deferReply().catch(() => {});

    const { CrawlingService } = await import('../../services/crawling.service');
    const crawlingService = this.moduleRef.get(CrawlingService, {
      strict: false,
    });

    try {
      await crawlingService.handleCron();
      await interaction
        .editReply('✅ Manual crawl cycle completed.')
        .catch(() => {});
    } catch (error) {
      await interaction
        .editReply(`❌ Crawl failed: ${(error as Error).message}`)
        .catch(() => {});
    }
  }

  private async cmdBatchHistory(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const { BatchProcessingService } =
      await import('../../services/batch-processing.service');
    const batchService = this.moduleRef.get(BatchProcessingService, {
      strict: false,
    });
    const history = batchService.getRecentJobHistory();

    if (history.length === 0) {
      await interaction.reply('ℹ️ No recent batch jobs.').catch(() => {});
      return;
    }

    const raw = JSON.stringify(history, null, 2);
    const truncated = raw.length > 3800 ? raw.slice(0, 3797) + '…' : raw;

    const embed = new EmbedBuilder()
      .setColor(0x3b82f6)
      .setTitle('📋 Recent Batch History')
      .setDescription(`\`\`\`json\n${truncated}\n\`\`\``)
      .setTimestamp()
      .setFooter({
        text: `${history.length} job(s) shown | LawCast Debug Bridge`,
      });

    await interaction.reply({ embeds: [embed] }).catch(() => {});
  }

  private async cmdWebhooks(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const { WebhookService } = await import('../../services/webhook.service');
    const webhookService = this.moduleRef.get(WebhookService, {
      strict: false,
    });
    const stats = await webhookService.getDetailedStatsForApi({
      nodeEnv: process.env.NODE_ENV,
    });

    const raw = JSON.stringify(stats, null, 2);
    const truncated = raw.length > 3800 ? raw.slice(0, 3797) + '…' : raw;

    const embed = new EmbedBuilder()
      .setColor(0x3b82f6)
      .setTitle('🔗 Webhook Stats')
      .setDescription(`\`\`\`json\n${truncated}\n\`\`\``)
      .setTimestamp()
      .setFooter({ text: 'LawCast Debug Bridge' });

    await interaction.reply({ embeds: [embed] }).catch(() => {});
  }

  private async cmdLogLevel(
    interaction: ChatInputCommandInteraction,
    ctx: BridgeCommandContext,
  ): Promise<void> {
    const requested = interaction.options.getString('level');

    if (!requested) {
      await interaction
        .reply(
          `Current log level: **${BRIDGE_LOG_LEVEL_LABELS[ctx.currentLogLevel]}** (${ctx.currentLogLevel})`,
        )
        .catch(() => {});
      return;
    }

    const levelMap: Record<string, BridgeLogLevel> = {
      error: BridgeLogLevel.ERROR,
      warn: BridgeLogLevel.WARN,
      log: BridgeLogLevel.LOG,
      debug: BridgeLogLevel.DEBUG,
      verbose: BridgeLogLevel.VERBOSE,
    };

    const oldLevel = ctx.currentLogLevel;
    ctx.setLogLevel(levelMap[requested]);
    await interaction
      .reply(
        `✅ Log level changed: **${BRIDGE_LOG_LEVEL_LABELS[oldLevel]}** → **${BRIDGE_LOG_LEVEL_LABELS[levelMap[requested]]}**`,
      )
      .catch(() => {});
  }
}
