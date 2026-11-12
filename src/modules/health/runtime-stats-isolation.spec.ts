import { createServer, type Server } from 'node:http';
import { performance } from 'node:perf_hooks';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { ApiController } from '../../controllers/api.controller';
import { OllamaClientService } from '../ollama/ollama-client.service';
import { RuntimeStatsService } from './runtime-stats.service';

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe('runtime telemetry while a real stats HTTP dependency waits', () => {
  it('keeps the runtime handler independent and identifies the pending health stage', async () => {
    let started: () => void;
    const healthStarted = new Promise<void>((resolve) => (started = resolve));
    let release: () => void;
    const releaseHealth = new Promise<void>((resolve) => (release = resolve));
    const dependency = createServer((request, response) => {
      if (request.url !== '/api/tags') {
        response.writeHead(501).end();
        return;
      }
      started();
      void releaseHealth.then(() =>
        response
          .setHeader('content-type', 'application/json')
          .end('{"models":[]}'),
      );
    });
    const port = await listen(dependency);
    const values = {
      'ollama.enabled': true,
      'ollama.apiUrl': `http://127.0.0.1:${port}`,
      'ollama.model': 'fixture',
      'ollama.healthTimeoutMs': 3000,
    };
    const client = new OllamaClientService({
      get: (key: string, fallback: unknown) => values[key] ?? fallback,
    } as ConfigService);
    const service = new RuntimeStatsService(
      { get: async () => null } as never,
      {} as never,
      {} as never,
    );
    const context = { runtimeStatsService: service };
    const logger = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    const full = () =>
      service.getAggregatedStats(
        { nodeEnv: 'production' },
        { getDetailedStatsForApi: async () => ({ total: 0 }) } as never,
        {
          getCacheInfo: async () => ({ lastUpdated: null }),
          getOllamaMetrics: () => client.getMetrics(),
          getSchedulerExecutionState: () => ({
            isProcessing: false,
            isPendingProcessing: false,
          }),
        } as never,
        { getArchiveCount: async () => 0 } as never,
        {
          getExecutionState: () => ({ phases: [], runningPhases: [] }),
          getIsDoneSyncStatus: () => null,
          getLegacyGenesisSeedStatus: () => null,
        } as never,
        {
          getComparableChangeSummary: async () => ({ comparableEventTotal: 0 }),
        } as never,
        { getStatsForApi: async () => ({ total: 0 }) } as never,
        { getCronJobsStatus: () => [] } as never,
      );
    const api = createServer((request, response) => {
      void (
        request.url === '/runtime'
          ? ApiController.prototype.getStats.call(context, 'runtime')
          : full()
      ).then((value) =>
        response
          .setHeader('content-type', 'application/json')
          .end(JSON.stringify(value)),
      );
    });
    const apiPort = await listen(api);
    try {
      const pending = globalThis.fetch(`http://127.0.0.1:${apiPort}/full`);
      await healthStarted;
      const before = performance.now();
      const runtime = await globalThis
        .fetch(`http://127.0.0.1:${apiPort}/runtime`)
        .then((value) => value.json());
      expect(runtime.data.nodeRuntime).toEqual(
        expect.objectContaining({ memory: expect.any(Object) }),
      );
      expect(performance.now() - before).toBeLessThan(1000);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const events = logger.mock.calls.map(([line]) =>
        JSON.parse(String(line)),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          event: 'stats_read_pending',
          stages: expect.arrayContaining([
            expect.objectContaining({ name: 'ollama', status: 'pending' }),
          ]),
        }),
      );
      release();
      expect((await pending).status).toBe(200);
      await new Promise((resolve) => setImmediate(resolve));
      expect(
        logger.mock.calls.map(([line]) => JSON.parse(String(line))),
      ).toContainEqual(
        expect.objectContaining({
          event: 'stats_read_finished',
          stages: expect.arrayContaining([
            expect.objectContaining({ name: 'ollama', status: 'ok' }),
          ]),
        }),
      );
    } finally {
      release();
      await close(api);
      await close(dependency);
      logger.mockRestore();
    }
  });
});
