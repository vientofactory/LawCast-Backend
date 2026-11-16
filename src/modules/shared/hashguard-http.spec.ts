import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import request from 'supertest';
import { HashGuardClient } from 'hashguard-client';
import { HashguardService } from './hashguard.service';
import { DiscussionsController } from '../discussions/controllers/discussions.controller';
import { DiscussionsService } from '../discussions/discussions.service';
import { DiscussionsRateLimitService } from '../discussions/discussions-rate-limit.service';

describe('Hashguard HTTP contract', () => {
  let upstream: Server;
  let app: INestApplication;
  let client: HashGuardClient;
  let unavailable = false;
  let sequence = 0;
  const subject = '203.0.113.10';
  const tokens = new Map<string, { context: string; used: boolean }>();
  const writes = { createThread: jest.fn(), addComment: jest.fn() };
  const assertions: Record<string, unknown>[] = [];

  beforeAll(async () => {
    upstream = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const data = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      if (unavailable) {
        res
          .writeHead(503)
          .end(JSON.stringify({ code: 'POW_TOKEN_STATE_UNAVAILABLE' }));
        return;
      }
      if (req.url === '/v1/pow/assessments') {
        const token = `assertion-${++sequence}`;
        tokens.set(token, { context: data.context, used: false });
        res.end(
          JSON.stringify({
            action: 'allow',
            riskScore: 0,
            verification: {
              proofToken: token,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          }),
        );
        return;
      }
      if (req.url === '/v1/pow/assertions/introspect') {
        assertions.push(data);
        const token = tokens.get(data.proofToken);
        const valid =
          !!token &&
          !token.used &&
          data.expectedContext === token.context &&
          data.expectedSubject === subject &&
          data.consume === true;
        if (valid) token.used = true;
        res.end(
          JSON.stringify({
            valid,
            ...(valid ? { subject, context: token.context } : {}),
          }),
        );
        return;
      }
      res.writeHead(501).end('{}');
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, '127.0.0.1', resolve),
    );
    const baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    client = new HashGuardClient({ baseUrl });
    const module = await Test.createTestingModule({
      controllers: [DiscussionsController],
      providers: [
        HashguardService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, fallback: string) =>
              key === 'hashguard.apiUrl' ? baseUrl : fallback,
          },
        },
        { provide: DiscussionsService, useValue: writes },
        {
          provide: DiscussionsRateLimitService,
          useValue: { assertAllowed: jest.fn() },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  beforeEach(() => {
    unavailable = false;
    jest.clearAllMocks();
    writes.createThread.mockResolvedValue({ thread: { id: 1 } });
    writes.addComment.mockResolvedValue({ id: 2 });
  });

  afterAll(async () => {
    await app?.close();
    await new Promise<void>((resolve) => upstream?.close(() => resolve()));
  });

  const path = '/api/notices/1/discussions';
  const payload = { title: 'Thread', password: 'password', content: 'Content' };

  async function proof(context = 'discussion-thread') {
    return (await client.execute(context)).verification.proofToken;
  }

  it('allows each bound assertion exactly once over real SDK HTTP', async () => {
    const token = await proof();
    await request(app.getHttpServer())
      .post(path)
      .set('x-lawcast-client-ip', subject)
      .send({ ...payload, proof: token })
      .expect(201);
    await request(app.getHttpServer())
      .post(path)
      .set('x-lawcast-client-ip', subject)
      .send({ ...payload, proof: token })
      .expect(400);
    expect(writes.createThread).toHaveBeenCalledTimes(1);
    expect(assertions.at(-1)).toEqual({
      proofToken: token,
      consume: true,
      expectedContext: 'discussion-thread',
      expectedSubject: subject,
    });
  });

  it('rejects cross-context and cross-IP use without consuming the correct assertion', async () => {
    const token = await proof('discussion-comment');
    await request(app.getHttpServer())
      .post(path)
      .set('x-lawcast-client-ip', subject)
      .send({ ...payload, proof: token })
      .expect(400);
    const comments = '/api/discussions/threads/1/comments';
    const body = { password: 'password', content: 'Content', proof: token };
    await request(app.getHttpServer())
      .post(comments)
      .set('x-lawcast-client-ip', '203.0.113.11')
      .send(body)
      .expect(400);
    await request(app.getHttpServer())
      .post(comments)
      .set('x-lawcast-client-ip', subject)
      .send(body)
      .expect(201);
    expect(writes.createThread).not.toHaveBeenCalled();
    expect(writes.addComment).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['numeric', 123],
    ['oversized', 'x'.repeat(4097)],
  ])(
    'rejects an invalid proof field before storage (%s)',
    async (_label, token) => {
      const count = assertions.length;
      await request(app.getHttpServer())
        .post(path)
        .set('x-lawcast-client-ip', subject)
        .send({ ...payload, proof: token })
        .expect(400);
      expect(assertions).toHaveLength(count);
      expect(writes.createThread).not.toHaveBeenCalled();
    },
  );

  it('fails closed when token state is unavailable', async () => {
    const token = await proof();
    unavailable = true;
    await request(app.getHttpServer())
      .post(path)
      .set('x-lawcast-client-ip', subject)
      .send({ ...payload, proof: token })
      .expect(400);
    expect(writes.createThread).not.toHaveBeenCalled();
  });
});
