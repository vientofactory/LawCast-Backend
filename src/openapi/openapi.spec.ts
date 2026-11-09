import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ApiController } from '../controllers/api.controller';
import { ApiProposalStatsController } from '../controllers/api-proposal-stats.controller';
import { AdminNoticesController } from '../modules/admin-notices/controllers/admin-notices.controller';
import { DiscussionsController } from '../modules/discussions/controllers/discussions.controller';
import { SemanticSearchController } from '../modules/semantic-search/semantic-search.controller';
import { isLocalOpenApiEnabled, setupOpenApi } from './openapi';

describe('local OpenAPI', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      providers: [{ provide: ConfigService, useValue: { get: jest.fn() } }],
      controllers: [
        ApiController,
        ApiProposalStatsController,
        AdminNoticesController,
        DiscussionsController,
        SemanticSearchController,
      ],
    })
      .useMocker(() => ({}))
      .compile();
    app = module.createNestApplication();
    setupOpenApi(app, 3091, () => 'test-version');
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it.each([
    ['development', 'true', true],
    ['development', 'false', false],
    ['development', undefined, false],
    ['production', 'true', false],
    ['test', 'true', false],
    [undefined, 'true', false],
  ])(
    'gates documentation for NODE_ENV=%s and flag=%s',
    (env, flag, enabled) => {
      expect(isLocalOpenApiEnabled(env, flag)).toBe(enabled);
    },
  );

  it('serves a Swagger UI and a loopback OpenAPI document with unique operation IDs', async () => {
    await request(app.getHttpServer())
      .get('/docs')
      .expect(200)
      .expect(/Swagger UI/);
    const { body } = await request(app.getHttpServer())
      .get('/openapi.json')
      .expect(200)
      .expect('Content-Type', /json/);
    expect(body.openapi).toBe('3.1.0');
    expect(body.info.version).toBe('test-version');
    expect(body.servers.map(({ url }) => url)).toEqual([
      'http://127.0.0.1:3091',
    ]);

    const operations = Object.values(body.paths).flatMap((path) =>
      Object.values(path),
    );
    expect(operations.every(({ operationId }) => !!operationId)).toBe(true);
    expect(new Set(operations.map(({ operationId }) => operationId)).size).toBe(
      operations.length,
    );
    expect(body.paths['/api/version'].get.responses['200']).toBeDefined();
    expect(body.paths['/api/announcements'].get).toBeDefined();
    expect(body.paths['/api/stats/proposals'].get).toBeDefined();
  });

  it('preserves query defaults, path parameters and JSON bodies for Bruno', async () => {
    const { body } = await request(app.getHttpServer())
      .get('/openapi.json')
      .expect(200);
    expect(body.paths['/api/notices/archive'].get.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'page',
          required: false,
          schema: { type: 'integer', default: 1 },
        }),
      ]),
    );
    expect(body.paths['/api/notices/semantic-search'].get.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'query', required: true, in: 'query' }),
      ]),
    );
    const removeComment =
      body.paths['/api/discussions/comments/{commentId}'].delete;
    expect(removeComment.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'commentId',
          in: 'path',
          required: true,
        }),
      ]),
    );
    expect(
      removeComment.requestBody.content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/DeleteCommentDto' });
    expect(body.components.schemas.CreateThreadDto.required).toEqual([
      'title',
      'password',
      'content',
    ]);
    expect(
      body.components.schemas.CreateWebhookDto.properties.proof.writeOnly,
    ).toBe(true);
  });
});
