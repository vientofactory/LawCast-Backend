import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { loadavg } from 'node:os';
import { APP_CONSTANTS } from '../../config/app.config';
import {
  BridgeLogLevel,
  BRIDGE_LOG_LEVEL_LABELS,
  BridgeCommandContext,
} from './discord-bridge.types';

@Injectable()
export class DiscordBridgeOperationsCommandsService {
  constructor(private readonly moduleRef: ModuleRef) {}

  async execute(
    interaction: ChatInputCommandInteraction,
    ctx: BridgeCommandContext,
  ): Promise<boolean> {
    switch (interaction.commandName) {
      case 'status':
        await this.cmdStatus(interaction, ctx);
        return true;
      case 'health':
        await this.cmdHealth(interaction);
        return true;
      case 'stats':
        await this.cmdStats(interaction);
        return true;
      case 'cache':
        await this.cmdCache(interaction);
        return true;
      case 'crawl':
        await this.cmdCrawl(interaction);
        return true;
      case 'batch-history':
        await this.cmdBatchHistory(interaction);
        return true;
      case 'webhooks':
        await this.cmdWebhooks(interaction);
        return true;
      case 'loglevel':
        await this.cmdLogLevel(interaction, ctx);
        return true;
      case 'locks':
        await this.cmdLocks(interaction);
        return true;
      case 'browser-lease':
        await this.cmdBrowserGuard(interaction);
        return true;
      default:
        return false;
    }
  }

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
      await import('../health/health-check.service');
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
      await import('../health/runtime-stats.service');
    const { WebhookService } = await import('../webhook/webhook.service');
    const { CrawlingService } = await import('../crawling/crawling.service');
    const { BatchProcessingService } =
      await import('../shared/batch-processing.service');
    const { NoticeArchiveService } =
      await import('../notice/notice-archive.service');
    const { ArchiveSyncService } =
      await import('../crawling/archive-sync.service');

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

    const fmtMB = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;
    const fmtMs = (ms: number | null | undefined) =>
      ms != null ? `${ms} ms` : 'N/A';
    const fmtBool = (v: boolean | null | undefined) =>
      v == null ? 'N/A' : v ? '✅' : '❌';
    const fmtPct = (v: number | null | undefined) =>
      v != null ? `${v.toFixed(1)}%` : 'N/A';

    const mem = stats.nodeRuntime.memory;
    const el = stats.nodeRuntime.eventLoopDelay as {
      mean: number;
      percentiles: { p50: number; p90: number; p99: number };
      exceeds: number;
    } | null;
    const wh = stats.webhooks as {
      total: number;
      active: number;
      efficiency: number;
    };
    const cache = stats.cache as {
      size: number;
      maxSize: number;
      isInitialized: boolean;
    };
    const archive = stats.archive;
    const batch = stats.batchProcessing as { jobCount: number };
    const ollama = stats.ollama as {
      model: string;
      summary: {
        total: number;
        success: number;
        failed: number;
        successRate: number;
      };
      health: { status: string; lastLatencyMs: number | null };
    };

    const embed = new EmbedBuilder()
      .setColor(0x3b82f6)
      .setTitle('📈 Runtime Stats')
      .addFields(
        { name: 'Mem · RSS', value: fmtMB(mem.rss), inline: true },
        { name: 'Mem · Heap', value: fmtMB(mem.heapUsed), inline: true },
        { name: 'Mem · Total', value: fmtMB(mem.heapTotal), inline: true },
        { name: 'EL · Mean', value: fmtMs(el?.mean), inline: true },
        { name: 'EL · P99', value: fmtMs(el?.percentiles?.p99), inline: true },
        {
          name: 'EL · Over',
          value: el != null ? String(el.exceeds) : 'N/A',
          inline: true,
        },
        { name: 'WH · Total', value: String(wh.total), inline: true },
        { name: 'WH · Active', value: String(wh.active), inline: true },
        { name: 'WH · Eff.', value: fmtPct(wh.efficiency), inline: true },
        { name: 'Archives', value: String(archive.count), inline: true },
        {
          name: 'Sync Done',
          value: archive.isDoneSync?.status ?? 'N/A',
          inline: true,
        },
        {
          name: 'AI Enabled',
          value: fmtBool(stats.aiSummaryEnabled),
          inline: true,
        },
        { name: 'Cache Size', value: String(cache.size), inline: true },
        { name: 'Cache Max', value: String(cache.maxSize), inline: true },
        {
          name: 'Cache Init',
          value: fmtBool(cache.isInitialized),
          inline: true,
        },
        { name: 'Batch Jobs', value: String(batch.jobCount), inline: true },
        { name: 'Ollama Model', value: ollama.model ?? 'N/A', inline: true },
        {
          name: 'Ollama Health',
          value: ollama.health?.status ?? 'N/A',
          inline: true,
        },
        {
          name: 'AI · Total',
          value: String(ollama.summary?.total ?? 0),
          inline: true,
        },
        {
          name: 'AI · Success',
          value: String(ollama.summary?.success ?? 0),
          inline: true,
        },
        {
          name: 'AI · Failed',
          value: String(ollama.summary?.failed ?? 0),
          inline: true,
        },
        {
          name: 'AI · Rate',
          value: fmtPct(ollama.summary?.successRate),
          inline: true,
        },
        {
          name: 'AI · Latency',
          value: fmtMs(ollama.health?.lastLatencyMs),
          inline: true,
        },
      )
      .setTimestamp()
      .setFooter({ text: 'LawCast Debug Bridge' });

    await interaction.reply({ embeds: [embed] }).catch(() => {});
  }

  private async cmdCache(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const { CacheService } = await import('../cache/cache.service');
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

    const { CrawlingService } = await import('../crawling/crawling.service');
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
      await import('../shared/batch-processing.service');
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
    const { WebhookService } = await import('../webhook/webhook.service');
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
        `✅ Log level changed: **${BRIDGE_LOG_LEVEL_LABELS[oldLevel]}** -> **${BRIDGE_LOG_LEVEL_LABELS[levelMap[requested]]}**`,
      )
      .catch(() => {});
  }

  private async cmdLocks(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const { CrawlingService } = await import('../crawling/crawling.service');
    const { ArchiveSyncService } =
      await import('../crawling/archive-sync.service');

    const crawlingService = this.moduleRef.get(CrawlingService, {
      strict: false,
    });
    const archiveSyncService = this.moduleRef.get(ArchiveSyncService, {
      strict: false,
    });

    const scheduler = crawlingService.getSchedulerExecutionState();
    const archive = archiveSyncService.getExecutionState();

    const runningPhases =
      archive.runningPhases.length > 0
        ? archive.runningPhases.join(', ')
        : 'none';
    const backgroundTasks =
      scheduler.activeBackgroundTasks.length > 0
        ? scheduler.activeBackgroundTasks.join(', ')
        : 'none';

    const recentPhaseStates = archive.phases
      .map(
        (phase) =>
          `${phase.name}: ${phase.status}` +
          (phase.lastError ? ` (err=${phase.lastError})` : ''),
      )
      .join('\n');

    const cronLayout = APP_CONSTANTS.CRON.EXPRESSIONS;

    const embed = new EmbedBuilder()
      .setColor(0xf59e0b)
      .setTitle('🔒 Lock / Phase Debug')
      .addFields(
        {
          name: 'Scheduler',
          value:
            `initialized=${scheduler.isInitialized} ` +
            `processing=${scheduler.isProcessing} ` +
            `busy(no-bg)=${crawlingService.isSchedulerBusy({ includeBackground: false })} ` +
            `busy(with-bg)=${crawlingService.isSchedulerBusy({ includeBackground: true })}`,
          inline: false,
        },
        {
          name: 'Background Tasks',
          value: `count=${scheduler.activeBackgroundTaskCount}\n${backgroundTasks}`,
          inline: false,
        },
        {
          name: 'Archive Sync Phases',
          value: `anyRunning=${archive.isAnyPhaseRunning}\nrunning=${runningPhases}`,
          inline: false,
        },
        {
          name: 'Phase States',
          value:
            recentPhaseStates.length > 0
              ? recentPhaseStates.slice(0, 1024)
              : 'none',
          inline: false,
        },
      )
      .setTimestamp()
      .setFooter({ text: 'LawCast Debug Bridge' });

    const cronRaw = JSON.stringify(cronLayout, null, 2);
    const cronSnippet =
      cronRaw.length > 1000 ? cronRaw.slice(0, 997) + '…' : cronRaw;
    embed.addFields({
      name: 'Cron Layout',
      value: `\`\`\`json\n${cronSnippet}\n\`\`\``,
      inline: false,
    });

    await interaction.reply({ embeds: [embed] }).catch(() => {});
  }

  private async cmdBrowserGuard(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const { BrowserLeaseManagerService } =
      await import('../crawling/browser-lease-manager.service');

    const browserLeaseService = this.moduleRef.get(BrowserLeaseManagerService, {
      strict: false,
    });

    const state = await browserLeaseService.getDebugState();
    const mem = process.memoryUsage();
    const loadAvg = loadavg();
    const fmtBytes = (value: number): string =>
      `${(value / 1024 / 1024).toFixed(1)} MB`;

    const embed = new EmbedBuilder()
      .setColor(0x0ea5e9)
      .setTitle('🌐 Browser Lease Manager')
      .addFields(
        {
          name: 'Process',
          value:
            `pid=${process.pid} ` +
            `platform=${process.platform} ` +
            `arch=${process.arch} ` +
            `node=${process.version} `,
          inline: false,
        },
        {
          name: 'Process Memory',
          value:
            `rss=${fmtBytes(mem.rss)} ` +
            `heapUsed=${fmtBytes(mem.heapUsed)} ` +
            `heapTotal=${fmtBytes(mem.heapTotal)}`,
          inline: false,
        },
        {
          name: 'System Load',
          value:
            `load1=${loadAvg[0].toFixed(2)} ` +
            `load5=${loadAvg[1].toFixed(2)} ` +
            `load15=${loadAvg[2].toFixed(2)}`,
          inline: false,
        },
        {
          name: 'Runtime',
          value:
            `activeLeases=${state.activeLeases} ` +
            `queuedWaiters=${state.queuedWaiters} ` +
            `trackedBrowserPids=${state.trackedBrowserPids.length} ` +
            `discoveredDescendants=${state.discoveredBrowserDescendants.length} ` +
            `shuttingDown=${state.shuttingDown}`,
          inline: false,
        },
        {
          name: 'Cleanup',
          value:
            `closeTimeoutMs=${state.closeTimeoutMs} ` +
            `forceKillWaitMs=${state.forceKillWaitMs}`,
          inline: false,
        },
      )
      .setTimestamp()
      .setFooter({ text: 'LawCast Debug Bridge' });

    if (state.discoveredBrowserDescendants.length > 0) {
      const procLines = state.discoveredBrowserDescendants
        .slice(0, 20)
        .map(
          (row) =>
            `pid=${row.pid} ppid=${row.ppid} stat=${row.stat} cmd=${row.command}`,
        );

      const procText = procLines.join('\n');
      const procSnippet =
        procText.length > 1000 ? procText.slice(0, 997) + '...' : procText;

      embed.addFields({
        name: 'Discovered Browser Descendants',
        value: `\`\`\`\n${procSnippet}\n\`\`\``,
        inline: false,
      });
    }

    await interaction.reply({ embeds: [embed] }).catch(() => {});
  }
}
