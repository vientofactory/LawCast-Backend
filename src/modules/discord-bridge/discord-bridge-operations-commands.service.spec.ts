import { MessageFlags } from 'discord.js';
import { DiscordBridgeOperationsCommandsService } from './discord-bridge-operations-commands.service';
import { BridgeLogLevel } from './discord-bridge.types';

jest.mock('../health/health-check.service', () => ({ HealthCheckService: class {} }));
jest.mock('../health/runtime-stats.service', () => ({ RuntimeStatsService: class {} }));
jest.mock('../webhook/webhook.service', () => ({ WebhookService: class {} }));
jest.mock('../crawling/crawling.service', () => ({ CrawlingService: class {} }));
jest.mock('../notice/notice-archive.service', () => ({ NoticeArchiveService: class {} }));
jest.mock('../crawling/archive-sync.service', () => ({ ArchiveSyncService: class {} }));
jest.mock('../cache/cache.service', () => ({ CacheService: class {} }));
jest.mock('../shared/batch-processing.service', () => ({ BatchProcessingService: class {} }));
jest.mock('../crawling/archive-orchestrator.service', () => ({
  ArchiveOrchestratorService: class {},
}));
jest.mock('../crawling/browser-lease-manager.service', () => ({
  BrowserLeaseManagerService: class {},
}));
jest.mock('../db-mirror/db-mirror.service', () => ({ DbMirrorService: class {} }));

describe('DiscordBridgeOperationsCommandsService', () => {
  function createService(get: jest.Mock) {
    const service = new DiscordBridgeOperationsCommandsService({ get } as any);
    return service;
  }

  function createInteraction(
    commandName: string,
    options: Record<string, jest.Mock> = {},
  ) {
    return {
      commandName,
      options,
      reply: jest.fn().mockResolvedValue(undefined),
      deferReply: jest.fn().mockResolvedValue(undefined),
      editReply: jest.fn().mockResolvedValue(undefined),
    } as any;
  }

  const ctx = {
    currentLogLevel: BridgeLogLevel.LOG,
    setLogLevel: jest.fn(),
    adminCount: 2,
  };

  describe('execute', () => {
    it('returns false for unknown commands', async () => {
      const service = createService(jest.fn());
      const interaction = createInteraction('unknown-command');

      await expect(service.execute(interaction, ctx)).resolves.toBe(false);
      expect(interaction.reply).not.toHaveBeenCalled();
    });
  });

  describe('status command', () => {
    it('replies with an embed containing uptime and memory fields', async () => {
      const service = createService(jest.fn());
      const interaction = createInteraction('status');

      await expect(service.execute(interaction, ctx)).resolves.toBe(true);

      expect(interaction.reply).toHaveBeenCalledTimes(1);
      const embed = interaction.reply.mock.calls[0][0].embeds[0];
      expect(embed.data.title).toBe('📊 Server Status');
      const fieldNames = embed.data.fields.map((f: { name: string }) => f.name);
      expect(fieldNames).toEqual(
        expect.arrayContaining([
          'Uptime',
          'Node Env',
          'Node.js',
          'RSS',
          'Heap Used',
          'Heap Total',
          'Bridge Log Level',
          'Admins',
        ]),
      );
      expect(embed.data.fields.find((f: { name: string }) => f.name === 'Admins').value).toBe(
        '2',
      );
    });
  });

  describe('health command', () => {
    it('replies with a healthy embed when health status is healthy', async () => {
      const healthCheckService = {
        getApiHealthPayload: jest.fn().mockResolvedValue({
          status: 'healthy',
          dependencies: { redis: 'ok', ollama: 'ok' },
        }),
      };
      const service = createService(jest.fn().mockReturnValue(healthCheckService));
      const interaction = createInteraction('health');

      await service.execute(interaction, ctx);

      expect(healthCheckService.getApiHealthPayload).toHaveBeenCalledWith({
        nodeEnv: process.env.NODE_ENV,
      });
      const embed = interaction.reply.mock.calls[0][0].embeds[0];
      expect(embed.data.title).toBe('✅ System Healthy');
      const fieldNames = embed.data.fields.map((f: { name: string }) => f.name);
      expect(fieldNames).toEqual(
        expect.arrayContaining(['Status', 'Redis', 'Ollama']),
      );
    });

    it('replies with a degraded embed when health status is not healthy', async () => {
      const healthCheckService = {
        getApiHealthPayload: jest.fn().mockResolvedValue({ status: 'degraded' }),
      };
      const service = createService(jest.fn().mockReturnValue(healthCheckService));
      const interaction = createInteraction('health');

      await service.execute(interaction, ctx);

      const embed = interaction.reply.mock.calls[0][0].embeds[0];
      expect(embed.data.title).toBe('⚠️ System Degraded');
    });
  });

  describe('stats command', () => {
    it('replies with an embed built from aggregated stats', async () => {
      const runtimeStats = {
        getAggregatedStats: jest.fn().mockResolvedValue({
          nodeRuntime: {
            memory: { rss: 104857600, heapUsed: 52428800, heapTotal: 209715200 },
            eventLoopDelay: {
              mean: 1.5,
              percentiles: { p50: 1, p90: 2, p99: 3 },
              exceeds: 4,
            },
          },
          webhooks: { total: 5, active: 3, efficiency: 60 },
          cache: { size: 10, maxSize: 100, isInitialized: true },
          archive: { count: 42, isDoneSync: { status: 'done' } },
          aiSummaryEnabled: true,
          ollama: {
            model: 'llama3',
            summary: { total: 10, success: 9, failed: 1, successRate: 90 },
            health: { status: 'healthy', lastLatencyMs: 123 },
          },
        }),
      };
      const service = createService(jest.fn().mockReturnValue(runtimeStats));
      const interaction = createInteraction('stats');

      await service.execute(interaction, ctx);

      expect(runtimeStats.getAggregatedStats).toHaveBeenCalledTimes(1);
      const embed = interaction.reply.mock.calls[0][0].embeds[0];
      expect(embed.data.title).toBe('📈 Runtime Stats');
      const fieldNames = embed.data.fields.map((f: { name: string }) => f.name);
      expect(fieldNames).toEqual(
        expect.arrayContaining([
          'Mem · RSS',
          'EL · Mean',
          'WH · Total',
          'Archives',
          'Sync Done',
          'AI Enabled',
          'Cache Size',
          'Ollama Model',
          'AI · Total',
          'AI · Rate',
        ]),
      );
      expect(
        embed.data.fields.find((f: { name: string }) => f.name === 'Archives').value,
      ).toBe('42');
    });
  });

  describe('cache command', () => {
    it('replies with cache status embed', async () => {
      const cacheService = {
        getCacheInfo: jest.fn().mockResolvedValue({
          size: 7,
          maxSize: 50,
          isInitialized: true,
          lastUpdated: '2026-01-01T00:00:00.000Z',
        }),
      };
      const service = createService(jest.fn().mockReturnValue(cacheService));
      const interaction = createInteraction('cache');

      await service.execute(interaction, ctx);

      const embed = interaction.reply.mock.calls[0][0].embeds[0];
      expect(embed.data.title).toBe('🗄️ Cache Status');
      const fieldNames = embed.data.fields.map((f: { name: string }) => f.name);
      expect(fieldNames).toEqual(
        expect.arrayContaining(['Size', 'Max Size', 'Initialized', 'Last Updated']),
      );
      expect(
        embed.data.fields.find((f: { name: string }) => f.name === 'Size').value,
      ).toBe('7');
    });

    it('shows N/A for last updated when it is missing', async () => {
      const cacheService = {
        getCacheInfo: jest.fn().mockResolvedValue({
          size: 0,
          maxSize: 50,
          isInitialized: false,
          lastUpdated: null,
        }),
      };
      const service = createService(jest.fn().mockReturnValue(cacheService));
      const interaction = createInteraction('cache');

      await service.execute(interaction, ctx);

      const embed = interaction.reply.mock.calls[0][0].embeds[0];
      expect(
        embed.data.fields.find((f: { name: string }) => f.name === 'Last Updated').value,
      ).toBe('N/A');
    });
  });

  describe('crawl command', () => {
    it('defers, runs the crawl, and reports success', async () => {
      const crawlingService = { handleCron: jest.fn().mockResolvedValue(undefined) };
      const service = createService(jest.fn().mockReturnValue(crawlingService));
      const interaction = createInteraction('crawl');

      await service.execute(interaction, ctx);

      expect(interaction.deferReply).toHaveBeenCalledTimes(1);
      expect(crawlingService.handleCron).toHaveBeenCalledTimes(1);
      expect(interaction.editReply).toHaveBeenCalledWith(
        '✅ Manual crawl cycle completed.',
      );
    });

    it('reports a failure message when the crawl throws', async () => {
      const crawlingService = {
        handleCron: jest.fn().mockRejectedValue(new Error('crawl exploded')),
      };
      const service = createService(jest.fn().mockReturnValue(crawlingService));
      const interaction = createInteraction('crawl');

      await service.execute(interaction, ctx);

      expect(interaction.editReply).toHaveBeenCalledWith(
        '❌ Crawl failed: crawl exploded',
      );
    });
  });

  describe('batch-history command', () => {
    it('replies with an info message when there is no history', async () => {
      const batchService = { getRecentJobHistory: jest.fn().mockReturnValue([]) };
      const service = createService(jest.fn().mockReturnValue(batchService));
      const interaction = createInteraction('batch-history');

      await service.execute(interaction, ctx);

      expect(interaction.reply).toHaveBeenCalledWith('ℹ️ No recent batch jobs.');
    });

    it('replies with an embed when history exists', async () => {
      const batchService = {
        getRecentJobHistory: jest.fn().mockReturnValue([
          { job: 'crawl', status: 'success', startedAt: '2026-01-01' },
          { job: 'sync', status: 'failed', startedAt: '2026-01-02' },
        ]),
      };
      const service = createService(jest.fn().mockReturnValue(batchService));
      const interaction = createInteraction('batch-history');

      await service.execute(interaction, ctx);

      const embed = interaction.reply.mock.calls[0][0].embeds[0];
      expect(embed.data.title).toBe('📋 Recent Batch History');
      expect(embed.data.description).toContain('crawl');
      expect(embed.data.footer.text).toBe('2 job(s) shown | LawCast Debug Bridge');
    });
  });

  describe('webhooks command', () => {
    it('replies with an embed containing the webhook stats JSON', async () => {
      const webhookService = {
        getDetailedStatsForApi: jest.fn().mockResolvedValue({
          total: 3,
          active: 2,
          inactive: 1,
        }),
      };
      const service = createService(jest.fn().mockReturnValue(webhookService));
      const interaction = createInteraction('webhooks');

      await service.execute(interaction, ctx);

      expect(webhookService.getDetailedStatsForApi).toHaveBeenCalledWith({
        nodeEnv: process.env.NODE_ENV,
      });
      const embed = interaction.reply.mock.calls[0][0].embeds[0];
      expect(embed.data.title).toBe('🔗 Webhook Stats');
      expect(embed.data.description).toContain('"total": 3');
    });
  });

  describe('loglevel command', () => {
    it('replies with the current level when no level is requested', async () => {
      const service = createService(jest.fn());
      const interaction = createInteraction('loglevel', {
        getString: jest.fn().mockReturnValue(null),
      });

      await service.execute(interaction, ctx);

      expect(interaction.reply).toHaveBeenCalledWith(
        'Current log level: **INFO** (2)',
      );
      expect(ctx.setLogLevel).not.toHaveBeenCalled();
    });

    it('updates the log level via ctx when a level is requested', async () => {
      const service = createService(jest.fn());
      const interaction = createInteraction('loglevel', {
        getString: jest.fn().mockReturnValue('debug'),
      });

      await service.execute(interaction, ctx);

      expect(ctx.setLogLevel).toHaveBeenCalledWith(BridgeLogLevel.DEBUG);
      expect(interaction.reply).toHaveBeenCalledWith(
        '✅ Log level changed: **INFO** -> **DEBUG**',
      );
    });
  });

  describe('locks command', () => {
    it('replies with a lock/phase debug embed', async () => {
      const archiveSyncService = {
        getExecutionState: jest.fn().mockReturnValue({
          isAnyPhaseRunning: true,
          isWriteHeavyPhaseRunning: true,
          runningPhases: ['pending sync'],
          runningWriteHeavyPhases: ['full sync apply'],
          asyncApply: {
            fullSyncQueueLength: 3,
            fullSyncWorkerRunning: true,
            fullSyncLastBatchProcessed: 12,
            fullSyncLastBatchAt: '2026-01-01T00:00:00.000Z',
            summaryBackfillQueueLength: 0,
            summaryBackfillWorkerRunning: false,
            summaryBackfillLastBatchProcessed: 5,
            summaryBackfillLastBatchAt: null,
          },
          phases: [
            {
              name: 'pending sync',
              status: 'running',
              lastRunAt: '2026-01-01T00:00:00.000Z',
              lastError: null,
            },
            {
              name: 'isDone sync',
              status: 'idle',
              lastRunAt: null,
              lastError: null,
            },
            {
              name: 'integrity check',
              status: 'idle',
              lastRunAt: null,
              lastError: 'previous failure with a long message that gets truncated',
            },
            {
              name: 'chain integrity audit',
              status: 'idle',
              lastRunAt: null,
              lastError: null,
            },
          ],
        }),
      };
      const crawlingService = {
        getSchedulerExecutionState: jest.fn().mockReturnValue({
          isProcessing: true,
          isPendingProcessing: false,
          activeBackgroundTasks: ['webhook flush'],
        }),
        isSchedulerBusy: jest.fn().mockReturnValue(true),
      };
      const get = jest
        .fn()
        .mockReturnValueOnce(crawlingService)
        .mockReturnValueOnce(archiveSyncService);
      const service = createService(get);
      const interaction = createInteraction('locks');

      await service.execute(interaction, ctx);

      const embed = interaction.reply.mock.calls[0][0].embeds[0];
      expect(embed.data.title).toBe('🔒 Lock / Phase Debug');
      const fieldNames = embed.data.fields.map((f: { name: string }) => f.name);
      expect(fieldNames).toEqual(
        expect.arrayContaining(['Scheduler / Phases', 'Write-Heavy', 'Recent Activity']),
      );
      expect(embed.data.fields[0].value).toContain('scheduler.busy=true');
      expect(embed.data.fields[0].value).toContain('archive.anyRunning=true');
      expect(embed.data.fields[1].value).toContain('fullSyncApply.queue=3');
      expect(embed.data.fields[2].value).toContain('pending sync: status=running');
    });

    it('truncates long phase errors in the recent activity section', async () => {
      const archiveSyncService = {
        getExecutionState: jest.fn().mockReturnValue({
          isAnyPhaseRunning: false,
          isWriteHeavyPhaseRunning: false,
          runningPhases: [],
          runningWriteHeavyPhases: [],
          asyncApply: {
            fullSyncQueueLength: 0,
            fullSyncWorkerRunning: false,
            fullSyncLastBatchProcessed: 0,
            fullSyncLastBatchAt: null,
            summaryBackfillQueueLength: 0,
            summaryBackfillWorkerRunning: false,
            summaryBackfillLastBatchProcessed: 0,
            summaryBackfillLastBatchAt: null,
          },
          phases: [
            {
              name: 'integrity check',
              status: 'failed',
              lastRunAt: null,
              lastError: 'x'.repeat(200),
            },
          ],
        }),
      };
      const crawlingService = {
        getSchedulerExecutionState: jest.fn().mockReturnValue({
          isProcessing: false,
          isPendingProcessing: false,
          activeBackgroundTasks: [],
        }),
        isSchedulerBusy: jest.fn().mockReturnValue(false),
      };
      const get = jest
        .fn()
        .mockReturnValueOnce(crawlingService)
        .mockReturnValueOnce(archiveSyncService);
      const service = createService(get);
      const interaction = createInteraction('locks');

      await service.execute(interaction, ctx);

      const embed = interaction.reply.mock.calls[0][0].embeds[0];
      expect(embed.data.fields[2].value).toContain(
        `integrity check: status=failed lastRun=none lastError=${'x'.repeat(57)}...`,
      );
    });
  });

  describe('pending-sync command', () => {
    it('replies with pending sync state embed', async () => {
      const archiveSyncService = {
        getExecutionState: jest.fn().mockReturnValue({
          phases: [
            {
              name: 'pending sync',
              status: 'running',
              lastRunAt: '2026-01-01T00:00:00.000Z',
              lastError: null,
            },
          ],
        }),
      };
      const archiveOrchestratorService = {
        getNsmDetailCrawlProgressState: jest.fn().mockReturnValue({
          status: 'running',
          reason: null,
          processedItems: 5,
          totalItems: 10,
          succeededItems: 4,
          failedItems: 1,
          currentIndex: 5,
          currentNoticeNum: 2200001,
          currentBillNo: '2201234',
          startedAt: '2026-01-01T00:00:00.000Z',
          lastUpdatedAt: '2026-01-01T00:05:00.000Z',
          lastCompletedAt: null,
        }),
      };
      const get = jest
        .fn()
        .mockReturnValueOnce(archiveSyncService)
        .mockReturnValueOnce(archiveOrchestratorService);
      const service = createService(get);
      const interaction = createInteraction('pending-sync');

      await service.execute(interaction, ctx);

      const embed = interaction.reply.mock.calls[0][0].embeds[0];
      expect(embed.data.title).toBe('🧾 Pending Sync State');
      const value = embed.data.fields[0].value;
      expect(value).toContain('pendingSync.status=running');
      expect(value).toContain('detailCrawl.status=running');
      expect(value).toContain('progress=5/10');
      expect(value).toContain('success=4 failed=1');
      expect(value).toContain('notice=2200001 billNo=2201234');
    });
  });

  describe('browser-lease command', () => {
    it('replies with browser lease manager debug embed', async () => {
      const browserLeaseService = {
        getDebugState: jest.fn().mockResolvedValue({
          activeLeases: 1,
          maxConcurrentLeases: 2,
          queuedWaiters: 1,
          trackedBrowserPids: [101, 102],
          discoveredBrowserDescendants: [
            { pid: 103, ppid: 101, stat: 'S', command: 'chrome --headless' },
          ],
          zombieDescendants: 0,
          shuttingDown: false,
          closeTimeoutMs: 5000,
          forceKillWaitMs: 3000,
        }),
      };
      const service = createService(jest.fn().mockReturnValue(browserLeaseService));
      const interaction = createInteraction('browser-lease');

      await service.execute(interaction, ctx);

      const embed = interaction.reply.mock.calls[0][0].embeds[0];
      expect(embed.data.title).toBe('🌐 Browser Lease Manager');
      const runtimeField = embed.data.fields.find(
        (f: { name: string }) => f.name === 'Runtime',
      );
      expect(runtimeField.value).toContain('activeLeases=1');
      expect(runtimeField.value).toContain('queuedWaiters=1');
      expect(runtimeField.value).toContain('zombieDescendants=0');
      const descendantsField = embed.data.fields.find(
        (f: { name: string }) => f.name === 'Discovered Browser Descendants',
      );
      expect(descendantsField.value).toContain('pid=103');
      expect(descendantsField.value).toContain('chrome --headless');
    });

    it('omits the descendants field when there are none', async () => {
      const browserLeaseService = {
        getDebugState: jest.fn().mockResolvedValue({
          activeLeases: 0,
          maxConcurrentLeases: 2,
          queuedWaiters: 0,
          trackedBrowserPids: [],
          discoveredBrowserDescendants: [],
          zombieDescendants: 0,
          shuttingDown: false,
          closeTimeoutMs: 5000,
          forceKillWaitMs: 3000,
        }),
      };
      const service = createService(jest.fn().mockReturnValue(browserLeaseService));
      const interaction = createInteraction('browser-lease');

      await service.execute(interaction, ctx);

      const embed = interaction.reply.mock.calls[0][0].embeds[0];
      const fieldNames = embed.data.fields.map((f: { name: string }) => f.name);
      expect(fieldNames).not.toContain('Discovered Browser Descendants');
    });
  });

  describe('mirror-upload command', () => {
    it('defers ephemerally and triggers the mirror job', async () => {
      const dbMirrorService = { runMirrorJob: jest.fn() };
      const service = createService(jest.fn().mockReturnValue(dbMirrorService));
      const interaction = createInteraction('mirror-upload');

      await service.execute(interaction, ctx);

      expect(interaction.deferReply).toHaveBeenCalledWith({
        flags: MessageFlags.Ephemeral,
      });
      expect(dbMirrorService.runMirrorJob).toHaveBeenCalledWith({ force: true });
      expect(interaction.editReply).toHaveBeenCalledWith(
        '✅ Database mirror upload triggered successfully.',
      );
    });

    it('reports a failure when the mirror job throws', async () => {
      const dbMirrorService = {
        runMirrorJob: jest.fn(() => {
          throw new Error('gdrive quota exceeded');
        }),
      };
      const service = createService(jest.fn().mockReturnValue(dbMirrorService));
      const interaction = createInteraction('mirror-upload');

      await service.execute(interaction, ctx);

      expect(interaction.editReply).toHaveBeenCalledWith(
        '❌ Database mirror upload failed: gdrive quota exceeded',
      );
    });
  });
});