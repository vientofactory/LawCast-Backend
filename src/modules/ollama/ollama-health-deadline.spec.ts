import { createServer, type Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { ConfigService } from '@nestjs/config';
import { OllamaClientService } from './ollama-client.service';

describe('Ollama health deadlines with a real local HTTP dependency', () => {
  let server: Server;
  let service: OllamaClientService;
  let mode: 'hang' | 'trickle' | 'healthy';
  let probes: number;
  let closed: Promise<void>;
  let resolveClosed: () => void;

  beforeEach(async () => {
    mode = 'hang';
    probes = 0;
    closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/tags') {
        probes++;
        if (mode === 'healthy') {
          response.end(JSON.stringify({ models: [{ name: 'fixture' }] }));
          return;
        }
        const finish = setTimeout(() => response.end('{"models":[]}'), 1000);
        const trickle =
          mode === 'trickle'
            ? setInterval(() => response.write(' '), 15)
            : null;
        response.once('close', () => {
          clearTimeout(finish);
          if (trickle) clearInterval(trickle);
          resolveClosed();
        });
      } else if (request.url === '/api/generate') {
        void delay(200).then(() =>
          response.end(
            JSON.stringify({
              response: '세액공제 확대로 기업 투자를 촉진합니다.',
            }),
          ),
        );
      } else {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address() as { port: number };
    const config = {
      'ollama.enabled': true,
      'ollama.apiUrl': `http://127.0.0.1:${address.port}`,
      'ollama.model': 'fixture',
      'ollama.timeout': 1800000,
      'ollama.healthTimeoutMs': 80,
    };
    service = new OllamaClientService({
      get: (key: string) => config[key],
    } as ConfigService);
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.each(['hang', 'trickle'] as const)(
    'aborts a %s response and closes the connection within the health deadline',
    async (behavior) => {
      mode = behavior;
      const started = performance.now();
      const result = await service.getMetrics();
      expect(performance.now() - started).toBeLessThan(800);
      expect(result.health.status).toBe('unhealthy');
      await closed;
      expect(probes).toBe(1);
    },
  );

  it('shares a failed cold probe across callers and can recover on the next forced check', async () => {
    const results = await Promise.all(
      Array.from({ length: 16 }, () => service.getMetrics()),
    );
    expect(probes).toBe(1);
    expect(
      results.every((result) => result.health.status === 'unhealthy'),
    ).toBe(true);
    mode = 'healthy';
    const recovered = await service.getMetrics({ forceHealthCheck: true });
    expect(recovered.health.status).toBe('healthy');
    expect(recovered.health.availableModelCount).toBe(1);
    expect(probes).toBe(2);
  });

  it('allows generation to outlive a health timeout on the same client', async () => {
    const [health, summary] = await Promise.all([
      service.getMetrics(),
      service.summarizeProposal('법률안', '투자를 지원합니다.'),
    ]);
    expect(health.health.status).toBe('unhealthy');
    expect(summary).toBe('세액공제 확대로 기업 투자를 촉진합니다.');
    expect((service as any).client.defaults.timeout).toBe(1800000);
  });
});
