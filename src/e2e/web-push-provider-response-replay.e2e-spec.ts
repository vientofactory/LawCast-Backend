import { execFileSync } from 'node:child_process';
import { createECDH, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import * as https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import webpush from 'web-push';
import { WebPushSubscription } from '../modules/notification/web-push-subscription.entity';
import { DiscussionWebPushBinding } from '../modules/notification/discussion-web-push-binding.entity';
import { WebPushSubscriptionService } from '../modules/notification/web-push-subscription.service';
import { WebPushNotificationService } from '../modules/notification/web-push-notification.service';

jest.setTimeout(30_000);

/**
 * Replays the documented invalid-subscription response shapes of the real
 * browser push providers through the REAL web-push client (TLS + VAPID +
 * aes128gcm payload encryption) and the real dispatch/exception path, then
 * asserts subscription state in a real sqlite database.
 *
 * Response shape sources:
 * - FCM legacy JSON (NotRegistered) and FCM HTTP v1 (UNREGISTERED 404,
 *   QUOTA_EXCEEDED 429, UNAVAILABLE 503):
 *   firebase.google.com/docs/cloud-messaging/error-codes
 * - Mozilla autopush (404 errno 102 Invalid URL endpoint, 410 errno 103
 *   Expired URL endpoint, 503 errno 201 backoff):
 *   mozilla-services.github.io/autopush-rs/http.html (Error Codes)
 * - Apple APNs web push (410 {"reason":"Unregistered","timestamp":...}):
 *   developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns
 * - Raw transport rejects: web-push v3 rejects raw Node syscall errors
 *   (node_modules/web-push/src/web-push-lib.js "pushRequest.on('error')").
 */

/**
 * Generates an ephemeral self-signed certificate (CN=127.0.0.1) for the local
 * replay server at runtime so no key material is committed to the repository.
 * Requires the openssl CLI. The suite disables TLS verification via
 * NODE_TLS_REJECT_UNAUTHORIZED and the https global agent, scoped to this file
 * and restored in afterAll.
 */
function generateSelfSignedCert(): { key: Buffer; cert: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), 'lawcast-e2e-tls-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'pipe' },
  );
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

interface ProviderReplay {
  name: string;
  path: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

// Only 404/410 mean the subscription itself is invalid/gone (RFC 8030).
const INVALIDATION_REPLAYS: ProviderReplay[] = [
  {
    name: 'FCM legacy NotRegistered (404)',
    path: '/fcm/legacy-not-registered',
    status: 404,
    headers: {},
    body: '{"multicast_id":1,"success":0,"failure":1,"canonical_ids":0,"results":[{"error":"NotRegistered"}]}',
  },
  {
    name: 'FCM HTTP v1 UNREGISTERED (404)',
    path: '/fcm/v1-unregistered',
    status: 404,
    headers: {},
    body: '{"error":{"code":404,"message":"Requested entity was not found.","status":"UNREGISTERED","details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"UNREGISTERED"}]}}',
  },
  {
    name: 'autopush Invalid URL endpoint (404, errno 102)',
    path: '/autopush/invalid-endpoint',
    status: 404,
    headers: {},
    body: '{"code":404,"errno":102,"error":"Not Found","message":"Invalid URL endpoint"}',
  },
  {
    name: 'autopush Expired URL endpoint (410, errno 103)',
    path: '/autopush/expired-endpoint',
    status: 410,
    headers: {},
    body: '{"code":410,"errno":103,"error":"Gone","message":"Expired URL endpoint"}',
  },
  {
    name: 'Apple APNs Unregistered (410)',
    path: '/apple/unregistered',
    status: 410,
    headers: {},
    body: '{"reason":"Unregistered","timestamp":1759000000000}',
  },
];

// 429/5xx are transient: retried in-flight, subscription kept.
const RETRYABLE_REPLAYS: ProviderReplay[] = [
  {
    name: 'FCM QUOTA_EXCEEDED (429, Retry-After)',
    path: '/fcm/quota-exceeded',
    status: 429,
    headers: { 'retry-after': '0' },
    body: '{"error":{"code":429,"message":"Quota exceeded.","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{"quotaId":"SendQuotaPerMinutePerProject","quotaMetric":"fcm.googleapis.com/default_requests","quotaLocation":"global","quotaValue":"600000"}]}]}}',
  },
  {
    name: 'FCM UNAVAILABLE (503, Retry-After)',
    path: '/fcm/unavailable',
    status: 503,
    headers: { 'retry-after': '0' },
    body: '{"error":{"code":503,"message":"The server was unavailable. Retry the same request with exponential backoff.","status":"UNAVAILABLE"}}',
  },
  {
    name: 'autopush 503 errno 201 (no Retry-After, exponential backoff)',
    path: '/autopush/service-unavailable',
    status: 503,
    headers: {},
    body: '{"code":503,"errno":201,"error":"Service Unavailable","message":"Use exponential back-off for retries"}',
  },
];

const DELIVERED_REPLAY: ProviderReplay = {
  name: 'autopush delivered (201)',
  path: '/autopush/delivered',
  status: 201,
  headers: {},
  body: '{"message-id":"e2e-00000000-0000-0000-0000-000000000000"}',
};

const ALL_REPLAYS = [
  ...INVALIDATION_REPLAYS,
  ...RETRYABLE_REPLAYS,
  DELIVERED_REPLAY,
];

describe('Web push provider invalid-response replay (real transport, real DB)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let webPushNotificationService: WebPushNotificationService;
  let webPushSubscriptionService: WebPushSubscriptionService;
  let server: https.Server;
  let baseUrl: string;
  let sendSpy: jest.SpyInstance;
  const requestLog = new Map<
    string,
    { count: number; authorization?: string; ttl?: string }
  >();
  let previousTlsEnv: string | undefined;
  let previousRejectUnauthorized: unknown;

  const vapidKeys = webpush.generateVAPIDKeys();

  function replayByPath(path: string): ProviderReplay | undefined {
    return ALL_REPLAYS.find((replay) => replay.path === path);
  }

  beforeAll(async () => {
    previousTlsEnv = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    // web-push issues plain https.request calls through the global agent;
    // trust the replay server's self-signed certificate deterministically
    // (the env var alone is not honored under the jest sandbox).
    const globalAgentOptions = (
      https.globalAgent as unknown as {
        options: Record<string, unknown>;
      }
    ).options;
    previousRejectUnauthorized = globalAgentOptions.rejectUnauthorized;
    globalAgentOptions.rejectUnauthorized = false;

    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'sqlite',
          database: ':memory:',
          autoLoadEntities: true,
          synchronize: true,
          dropSchema: true,
        }),
        TypeOrmModule.forFeature([
          WebPushSubscription,
          DiscussionWebPushBinding,
        ]),
      ],
      providers: [
        WebPushSubscriptionService,
        WebPushNotificationService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              switch (key) {
                case 'webPush.enabled':
                  return true;
                case 'webPush.vapidPublicKey':
                  return vapidKeys.publicKey;
                case 'webPush.vapidPrivateKey':
                  return vapidKeys.privateKey;
                case 'webPush.subject':
                  return 'mailto:e2e@example.com';
                case 'frontend.urls':
                  return ['https://lawcast.example'];
                default:
                  return undefined;
              }
            },
          },
        },
      ],
    }).compile();

    dataSource = moduleRef.get(DataSource);
    webPushNotificationService = moduleRef.get(WebPushNotificationService);
    webPushSubscriptionService = moduleRef.get(WebPushSubscriptionService);

    const tlsMaterial = generateSelfSignedCert();
    server = https.createServer(
      { key: tlsMaterial.key, cert: tlsMaterial.cert },
      (req, res) => {
        const path = req.url ?? '';
        const log = requestLog.get(path) ?? { count: 0 };
        log.count += 1;
        log.authorization = req.headers.authorization;
        log.ttl = req.headers.ttl as string | undefined;
        requestLog.set(path, log);
        req.resume();

        const replay = replayByPath(path);
        if (!replay) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(
            '{"code":404,"errno":102,"error":"Not Found","message":"Invalid URL endpoint"}',
          );
          return;
        }
        res.writeHead(replay.status, {
          'content-type': 'application/json',
          ...replay.headers,
        });
        res.end(replay.body);
      },
    );
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address() as AddressInfo;
    baseUrl = `https://127.0.0.1:${address.port}`;

    // Instrumentation only: wraps the real client and delegates to it.
    sendSpy = jest.spyOn(webpush, 'sendNotification');
  });

  afterAll(async () => {
    sendSpy?.mockRestore();
    if (previousTlsEnv === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsEnv;
    }
    (
      https.globalAgent as unknown as { options: Record<string, unknown> }
    ).options.rejectUnauthorized = previousRejectUnauthorized;
    if (server?.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await moduleRef?.close();
  });

  beforeEach(() => {
    sendSpy.mockClear();
    requestLog.clear();
  });

  async function createSubscription(
    endpoint: string,
  ): Promise<WebPushSubscription> {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    return webPushSubscriptionService.createOrReactivate({
      endpoint,
      p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
      userAgent: 'LawcastE2E',
    });
  }

  async function dispatch(subscription: WebPushSubscription) {
    return webPushNotificationService.sendNewNoticeBatch(
      {
        num: 9001,
        subject: '[e2e] provider response replay',
        proposerCategory: '정부',
        committee: '법제사법위원회',
        link: 'https://lawcast.example/notices/9001',
        contentId: null,
        attachments: { pdfFile: '', hwpFile: '' },
      } as any,
      [subscription],
    );
  }

  const reload = (id: number) =>
    dataSource.getRepository(WebPushSubscription).findOne({ where: { id } });

  describe('invalid subscriptions (404/410) are deactivated after a single attempt', () => {
    it.each(INVALIDATION_REPLAYS)(
      '$name deactivates the subscription',
      async (replay) => {
        const subscription = await createSubscription(
          `${baseUrl}${replay.path}`,
        );

        const summary = await dispatch(subscription);

        expect(summary).toMatchObject({
          targetCount: 1,
          successCount: 0,
          failedCount: 1,
          deactivatedCount: 1,
        });
        // Permanent responses are never retried.
        expect(sendSpy).toHaveBeenCalledTimes(1);

        const row = await reload(subscription.id);
        expect(row).toBeTruthy();
        expect(row!.isActive).toBe(false);
        expect(row!.failureCount).toBe(1);
        expect(row!.lastFailureReason).toBe(
          'Received unexpected response code',
        );
      },
    );
  });

  describe('transient failures (429/5xx) are retried and keep the subscription', () => {
    it.each(RETRYABLE_REPLAYS)(
      '$name retries in-flight and keeps the subscription',
      async (replay) => {
        const subscription = await createSubscription(
          `${baseUrl}${replay.path}`,
        );

        const summary = await dispatch(subscription);

        expect(summary).toMatchObject({
          targetCount: 1,
          successCount: 0,
          failedCount: 1,
          deactivatedCount: 0,
        });
        // Transient responses exhaust the in-flight attempts (3 max).
        expect(sendSpy).toHaveBeenCalledTimes(3);

        const row = await reload(subscription.id);
        expect(row).toBeTruthy();
        expect(row!.isActive).toBe(true);
        expect(row!.failureCount).toBe(1);
      },
    );
  });

  it('raw transport rejects (ENOTFOUND) are retried with backoff and keep the subscription', async () => {
    // .invalid never resolves (RFC 2606), so web-push rejects with the raw
    // Node DNS error instead of an HTTP response.
    const subscription = await createSubscription(
      'https://nonexistent.invalid/e2e/transport-raw-reject',
    );

    const summary = await dispatch(subscription);

    expect(summary).toMatchObject({
      targetCount: 1,
      successCount: 0,
      failedCount: 1,
      deactivatedCount: 0,
    });
    // Transport errors are transient (same retry class as 5xx): retried
    // in-flight with backoff, subscription never invalidated.
    expect(sendSpy).toHaveBeenCalledTimes(3);
    expect(requestLog.size).toBe(0);

    const row = await reload(subscription.id);
    expect(row).toBeTruthy();
    expect(row!.isActive).toBe(true);
    expect(row!.failureCount).toBe(1);
    expect(row!.lastFailureReason).toContain('ENOTFOUND');
  }, 20_000);

  it('delivers through real VAPID + encryption and records success state', async () => {
    const subscription = await createSubscription(
      `${baseUrl}${DELIVERED_REPLAY.path}`,
    );

    const summary = await dispatch(subscription);

    expect(summary).toMatchObject({
      targetCount: 1,
      successCount: 1,
      failedCount: 0,
      deactivatedCount: 0,
    });
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // The request really left through the web-push stack with VAPID auth and
    // TTL headers attached.
    const log = requestLog.get(DELIVERED_REPLAY.path);
    expect(log?.count).toBe(1);
    expect(log?.authorization).toMatch(/^vapid /);
    expect(log?.ttl).toBe('3600');

    const row = await reload(subscription.id);
    expect(row).toBeTruthy();
    expect(row!.isActive).toBe(true);
    expect(row!.failureCount).toBe(0);
    expect(row!.lastFailureReason).toBeNull();
    expect(row!.lastNotifiedAt).toBeTruthy();
  });
});
