import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { AdminNoticesService } from './admin-notices.service';
import { NOTION_PROPERTY } from './admin-notices.constants';

// The service runs the real official Notion SDK; only the transport (fetch)
// is faked, so URL/header assembly, 429 conversion and Retry-After parsing
// are exercised against real SDK code paths. The Client constructor wrapper
// exposes the options the service passed so the pinned wire contract
// (auth, API version, timeout, disabled retries) stays asserted directly.
jest.mock('@notionhq/client', () => {
  const actual = jest.requireActual('@notionhq/client') as {
    Client: new (options?: any) => any;
  };
  class ClientSpy extends actual.Client {
    static lastOptions: unknown;
    constructor(options?: unknown) {
      super(options);
      ClientSpy.lastOptions = options;
    }
  }
  return { ...actual, Client: ClientSpy, __clientState: ClientSpy };
});

describe('AdminNoticesService', () => {
  type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;
  /** Database-query transport seam (was mockPost over axios). */
  const mockQuery = jest.fn<FetchHandler>();
  /** Block-children transport seam (was mockGet over axios). */
  const mockBlocks = jest.fn<FetchHandler>();
  let fetchMock: jest.MockedFunction<typeof globalThis.fetch>;
  let fetchDescriptor: PropertyDescriptor | undefined;

  const createService = (
    overrides: Record<string, unknown> = {},
  ): AdminNoticesService => {
    const values: Record<string, unknown> = {
      'notion.apiKey': 'secret-token',
      'notion.databaseId': 'db-123',
      'notion.apiUrl': 'https://api.notion.com',
      'notion.timeout': 5000,
      'notion.cacheTtlMs': 60_000,
      // Pacing is disabled by default so tests stay fast; the interval is
      // asserted explicitly in its own test below.
      'notion.minRequestIntervalMs': 0,
      ...overrides,
    };
    const configService = {
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService;
    return new AdminNoticesService(configService);
  };

  const jsonResponse = (payload: unknown, init: ResponseInit = {}): Response =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
      ...init,
    });

  const queryResponse = (
    results: Record<string, unknown>[],
    extra: Record<string, unknown> = {},
  ): Response =>
    jsonResponse({
      results,
      has_more: false,
      next_cursor: null,
      ...extra,
    });

  const blockChildrenResponse = (
    results: Record<string, unknown>[],
    extra: Record<string, unknown> = {},
  ): Response =>
    jsonResponse({
      results,
      has_more: false,
      next_cursor: null,
      ...extra,
    });

  /** Notion's real 429 wire shape; the SDK converts it to APIResponseError. */
  const rateLimitResponse = (retryAfter?: string): Response =>
    jsonResponse(
      {
        object: 'error',
        status: 429,
        code: 'rate_limited',
        message: 'rate limited',
      },
      {
        status: 429,
        headers: {
          'content-type': 'application/json',
          ...(retryAfter ? { 'retry-after': retryAfter } : {}),
        },
      },
    );

  const errorResponse = (
    status: number,
    payload: Record<string, unknown>,
  ): Response => jsonResponse(payload, { status });

  const notionPage = (
    id: string,
    properties: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({ id, ...extra, properties });

  const publishedProps = (
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    [NOTION_PROPERTY.TITLE]: {
      type: 'title',
      title: [{ plain_text: '공지 제목' }],
    },
    [NOTION_PROPERTY.PUBLISHED]: { type: 'checkbox', checkbox: true },
    [NOTION_PROPERTY.STATUS]: {
      type: 'status',
      status: { name: '게시중' },
    },
    [NOTION_PROPERTY.ORDER]: { type: 'number', number: 1 },
    [NOTION_PROPERTY.CONTENT]: {
      type: 'rich_text',
      rich_text: [{ plain_text: '첫 줄' }, { plain_text: '\n두 번째 줄' }],
    },
    ...overrides,
  });

  /** First request's URL/init from the fetch seam (the actual wire call). */
  const firstFetchCall = (): [input: RequestInfo | URL, init?: RequestInit] => {
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    return fetchMock.mock.calls[0];
  };

  const fetchCallsTo = (urlFragment: string): string[] =>
    fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.includes(urlFragment));

  beforeEach(() => {
    jest.clearAllMocks();
    // Drop any queued one-time implementations from a previous test so an
    // unconsumed Once value can never leak into (and corrupt) the next test.
    mockQuery.mockReset();
    mockBlocks.mockReset();
    // Database queries and block-children listings default to empty results;
    // tests that exercise payloads override them with realistic responses.
    // Handlers build a fresh Response per call: a Response body can only be
    // read once, and the SDK reads it on every request.
    mockQuery.mockImplementation(async () => queryResponse([]));
    mockBlocks.mockImplementation(async () => blockChildrenResponse([]));
    fetchMock = jest.fn(
      async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        const url = String(input);
        return url.includes('/databases/')
          ? mockQuery(url, init)
          : mockBlocks(url, init);
      },
    );
    fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
    Object.defineProperty(globalThis, 'fetch', {
      value: fetchMock,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    if (fetchDescriptor) {
      Object.defineProperty(globalThis, 'fetch', fetchDescriptor);
    }
    jest.restoreAllMocks();
  });

  it('configures the official Notion client with auth, pinned version, timeout and no hidden retries', () => {
    createService();

    const state = jest.requireMock('@notionhq/client') as {
      __clientState: { lastOptions?: Record<string, unknown> };
    };
    expect(state.__clientState.lastOptions).toEqual(
      expect.objectContaining({
        auth: 'secret-token',
        baseUrl: 'https://api.notion.com',
        notionVersion: '2022-06-28',
        timeoutMs: 5000,
        // SDK-side retries must stay off: the first 429 has to surface here
        // so applyRateLimitBackoff owns the shared pause.
        retry: false,
      }),
    );
  });

  it('returns an empty list without calling Notion when unconfigured', async () => {
    const service = createService({ 'notion.apiKey': '' });

    await expect(service.getPublishedNotices()).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();

    const noDatabase = createService({ 'notion.databaseId': '' });
    await expect(noDatabase.getPublishedNotices()).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('queries only published rows and maps title/status/order/urgent/content/createdAt', async () => {
    const service = createService();
    mockQuery.mockImplementation(async () =>
      queryResponse([
        notionPage('page-1', publishedProps(), {
          // Real Notion pages always carry a top-level created_time.
          created_time: '2026-10-01T03:00:00.000Z',
        }),
        notionPage('page-2', {
          ...publishedProps({
            [NOTION_PROPERTY.TITLE]: {
              type: 'title',
              title: [{ plain_text: '두 번째 공지' }],
            },
            [NOTION_PROPERTY.STATUS]: {
              type: 'select',
              select: { name: '이벤트' },
            },
            [NOTION_PROPERTY.ORDER]: { type: 'number', number: 2 },
            [NOTION_PROPERTY.CONTENT]: {
              type: 'rich_text',
              rich_text: [{ plain_text: '내용 없음 없음' }],
            },
            [NOTION_PROPERTY.URGENT]: { type: 'checkbox', checkbox: true },
          }),
        }),
        // Unpublished row must never surface, even if the API filter drifts.
        notionPage('page-3', {
          ...publishedProps({
            [NOTION_PROPERTY.PUBLISHED]: { checkbox: false },
          }),
        }),
        // Empty title rows are not displayable notices.
        notionPage('page-4', {
          ...publishedProps({
            [NOTION_PROPERTY.TITLE]: { type: 'title', title: [] },
          }),
        }),
      ]),
    );

    const items = await service.getPublishedNotices();

    // The actual wire call: pinned base URL, classic query path, auth and
    // version headers, and the exact filter/sort/page-size body.
    const [input, init] = firstFetchCall();
    expect(String(input)).toBe(
      'https://api.notion.com/v1/databases/db-123/query',
    );
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual(
      expect.objectContaining({
        authorization: 'Bearer secret-token',
        'Notion-Version': '2022-06-28',
        'content-type': 'application/json',
      }),
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      filter: {
        property: NOTION_PROPERTY.PUBLISHED,
        checkbox: { equals: true },
      },
      sorts: [{ property: NOTION_PROPERTY.ORDER, direction: 'ascending' }],
      page_size: 100,
    });
    expect(items).toEqual([
      {
        id: 'page-1',
        title: '공지 제목',
        published: true,
        status: '게시중',
        order: 1,
        // The 긴급 property is absent entirely -> urgent stays false.
        urgent: false,
        // Newlines in the Notion body are preserved (never whitespace-collapsed).
        content: '첫 줄\n두 번째 줄',
        body: '',
        createdAt: '2026-10-01T03:00:00.000Z',
      },
      {
        id: 'page-2',
        title: '두 번째 공지',
        published: true,
        status: '이벤트',
        order: 2,
        urgent: true,
        content: '내용 없음 없음',
        body: '',
        // created_time missing entirely -> null, never an invalid date string.
        createdAt: null,
      },
    ]);
    // Only displayable (published + titled) rows get their block tree read.
    expect(mockBlocks).toHaveBeenCalledTimes(2);
    expect(fetchCallsTo('/v1/blocks/')).toEqual([
      'https://api.notion.com/v1/blocks/page-1/children',
      'https://api.notion.com/v1/blocks/page-2/children',
    ]);
  });

  it('converts a page block body into markdown via notion-to-md', async () => {
    const service = createService();
    mockQuery.mockImplementation(async () =>
      queryResponse([
        notionPage(
          'page-1',
          publishedProps({
            // The reported production case: the property is empty because the
            // real body lives in the page's block children.
            [NOTION_PROPERTY.CONTENT]: { type: 'rich_text', rich_text: [] },
          }),
        ),
      ]),
    );
    const annotations = {
      bold: false,
      italic: false,
      strikethrough: false,
      underline: false,
      code: false,
      color: 'default',
    };
    const text = (plain: string, overrides: Record<string, unknown> = {}) => ({
      type: 'text',
      text: { content: plain, link: null },
      annotations: { ...annotations, ...overrides },
      plain_text: plain,
      href: null,
    });
    mockBlocks.mockImplementation(async () =>
      blockChildrenResponse([
        {
          object: 'block',
          id: 'block-1',
          type: 'heading_1',
          has_children: false,
          heading_1: { rich_text: [text('마크다운 테스트')] },
        },
        {
          object: 'block',
          id: 'block-2',
          type: 'bulleted_list_item',
          has_children: false,
          bulleted_list_item: { rich_text: [text('asdf')] },
        },
        {
          object: 'block',
          id: 'block-3',
          type: 'bulleted_list_item',
          has_children: false,
          bulleted_list_item: { rich_text: [text('qwer')] },
        },
        {
          object: 'block',
          id: 'block-4',
          type: 'paragraph',
          has_children: false,
          paragraph: { rich_text: [text('볼드체', { bold: true })] },
        },
      ]),
    );

    const items = await service.getPublishedNotices();

    expect(fetchCallsTo('/v1/blocks/')).toEqual([
      'https://api.notion.com/v1/blocks/page-1/children',
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].content).toBe('');
    expect(items[0].body).toContain('# 마크다운 테스트');
    expect(items[0].body).toContain('- asdf\n- qwer');
    expect(items[0].body).toContain('**볼드체**');
  });

  it('keeps serving notices when one block body conversion fails', async () => {
    const service = createService();
    mockQuery.mockResolvedValue(
      queryResponse([notionPage('page-1', publishedProps())]),
    );
    mockBlocks.mockRejectedValue(new Error('network down'));

    const items = await service.getPublishedNotices();

    // The notice still renders from the property content.
    expect(items).toHaveLength(1);
    expect(items[0].content).toBe('첫 줄\n두 번째 줄');
    expect(items[0].body).toBe('');
  });

  it('applies the 429 backoff when a block body fetch is rate limited', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000_000);
    const service = createService();
    mockQuery.mockImplementation(async () =>
      queryResponse([notionPage('page-1', publishedProps())]),
    );
    mockBlocks.mockResolvedValue(rateLimitResponse());

    await expect(service.getPublishedNotices()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockBlocks).toHaveBeenCalledTimes(1);

    // Inside the default 1s cooldown: block fetches are Notion requests too,
    // so the whole board stops querying instead of hammering through 429s.
    nowSpy.mockReturnValue(1_000_000 + 999);
    await expect(service.getPublishedNotices()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockBlocks).toHaveBeenCalledTimes(1);
  });

  it('orders by 노출 순서 ascending with missing order last', async () => {
    const service = createService();
    mockQuery.mockImplementation(async () =>
      queryResponse([
        notionPage(
          'page-no-order',
          publishedProps({
            [NOTION_PROPERTY.ORDER]: { type: 'number', number: null },
          }),
        ),
        notionPage(
          'page-10',
          publishedProps({
            [NOTION_PROPERTY.ORDER]: { type: 'number', number: 10 },
          }),
        ),
        notionPage(
          'page-2',
          publishedProps({
            [NOTION_PROPERTY.ORDER]: { type: 'number', number: 2 },
          }),
        ),
      ]),
    );

    const items = await service.getPublishedNotices();

    expect(items.map((item) => item.id)).toEqual([
      'page-2',
      'page-10',
      'page-no-order',
    ]);
  });

  it('follows pagination cursors and combines the pages', async () => {
    const service = createService();
    mockQuery
      .mockResolvedValueOnce(
        queryResponse([notionPage('page-1', publishedProps())], {
          has_more: true,
          next_cursor: 'cursor-1',
        }),
      )
      .mockResolvedValueOnce(
        queryResponse([
          notionPage(
            'page-2',
            publishedProps({
              [NOTION_PROPERTY.ORDER]: { type: 'number', number: 2 },
            }),
          ),
        ]),
      );

    const items = await service.getPublishedNotices();

    expect(mockQuery).toHaveBeenCalledTimes(2);
    // The second wire call keeps the same path; the cursor travels in the
    // request body (Notion's database-query pagination contract).
    const [secondInput, secondInit] = fetchMock.mock.calls[1];
    expect(String(secondInput)).toBe(
      'https://api.notion.com/v1/databases/db-123/query',
    );
    expect(JSON.parse(String(secondInit?.body))).toEqual(
      expect.objectContaining({ start_cursor: 'cursor-1' }),
    );
    expect(items.map((item) => item.id)).toEqual(['page-1', 'page-2']);
  });

  it('serves the fresh cache without re-querying Notion', async () => {
    const service = createService();
    mockQuery.mockImplementation(async () =>
      queryResponse([notionPage('page-1', publishedProps())]),
    );

    const first = await service.getPublishedNotices();
    const second = await service.getPublishedNotices();

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('re-queries after the cache TTL expires', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000_000);
    const service = createService();
    mockQuery.mockImplementation(async () =>
      queryResponse([notionPage('page-1', publishedProps())]),
    );

    await service.getPublishedNotices();
    nowSpy.mockReturnValue(1_000_000 + 61_000);
    await service.getPublishedNotices();

    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('serves the stale snapshot immediately and refreshes in the background', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000_000);
    const service = createService();
    mockQuery.mockResolvedValueOnce(
      queryResponse([notionPage('page-1', publishedProps())]),
    );
    const first = await service.getPublishedNotices(); // seed the snapshot

    // TTL expired: the next read answers from the snapshot at once (the
    // request must not wait for Notion) and kicks off the refresh.
    nowSpy.mockReturnValue(1_000_000 + 61_000);
    mockQuery.mockResolvedValueOnce(
      queryResponse([
        notionPage('page-2', {
          ...publishedProps({
            [NOTION_PROPERTY.TITLE]: {
              type: 'title',
              title: [{ plain_text: '갱신된 공지' }],
            },
          }),
        }),
      ]),
    );
    const stale = await service.getPublishedNotices();

    expect(stale).toBe(first); // same (old) array reference, no wait
    expect(mockQuery).toHaveBeenCalledTimes(2); // background fetch started

    // Let the background flight settle: the next request serves the refresh.
    await new Promise((resolve) => setImmediate(resolve));
    const refreshed = await service.getPublishedNotices();

    expect(refreshed).not.toBe(first);
    expect(refreshed.map((item) => item.title)).toEqual(['갱신된 공지']);
    expect(mockQuery).toHaveBeenCalledTimes(2); // cache is fresh again
  });

  it('collapses concurrent stale reads into one background refresh', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000_000);
    const service = createService();
    mockQuery.mockResolvedValueOnce(
      queryResponse([notionPage('page-1', publishedProps())]),
    );
    await service.getPublishedNotices(); // seed the snapshot

    nowSpy.mockReturnValue(1_000_000 + 61_000);
    mockQuery.mockImplementation(async () =>
      queryResponse([notionPage('page-1', publishedProps())]),
    );
    const [first, second, third] = await Promise.all([
      service.getPublishedNotices(),
      service.getPublishedNotices(),
      service.getPublishedNotices(),
    ]);

    // All three get the stale snapshot; only one background fetch runs.
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(mockQuery).toHaveBeenCalledTimes(2); // 1 seed + 1 background
    // Let the background flight settle before the next test starts.
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('honors the cache TTL injected via NOTION_CACHE_TTL_MS', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000_000);
    const service = createService({ 'notion.cacheTtlMs': 10_000 });
    mockQuery.mockImplementation(async () =>
      queryResponse([notionPage('page-1', publishedProps())]),
    );

    await service.getPublishedNotices();
    nowSpy.mockReturnValue(1_000_000 + 5_000);
    await service.getPublishedNotices();
    // Still inside the injected TTL: served from cache.
    expect(mockQuery).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(1_000_000 + 10_000);
    await service.getPublishedNotices();
    // The injected TTL (10s, shorter than the 60s default) expired: refetched.
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('falls back to the default TTL when NOTION_CACHE_TTL_MS is not set', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000_000);
    const service = createService({ 'notion.cacheTtlMs': undefined });
    mockQuery.mockImplementation(async () =>
      queryResponse([notionPage('page-1', publishedProps())]),
    );

    await service.getPublishedNotices();
    nowSpy.mockReturnValue(1_000_000 + 59_000);
    await service.getPublishedNotices();
    expect(mockQuery).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(1_000_000 + 60_000);
    await service.getPublishedNotices();
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('shares one Notion fetch across concurrent cache misses (single-flight)', async () => {
    const service = createService();
    mockQuery.mockImplementation(async () =>
      queryResponse([notionPage('page-1', publishedProps())]),
    );

    const [first, second, third] = await Promise.all([
      service.getPublishedNotices(),
      service.getPublishedNotices(),
      service.getPublishedNotices(),
    ]);

    // A visitor burst must collapse into one Notion query sequence.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('spaces consecutive Notion requests by the configured minimum interval', async () => {
    const service = createService({ 'notion.minRequestIntervalMs': 150 });
    mockQuery
      .mockResolvedValueOnce(
        queryResponse([notionPage('page-1', publishedProps())], {
          has_more: true,
          next_cursor: 'cursor-1',
        }),
      )
      .mockResolvedValueOnce(
        queryResponse([
          notionPage(
            'page-2',
            publishedProps({
              [NOTION_PROPERTY.ORDER]: { type: 'number', number: 2 },
            }),
          ),
        ]),
      );

    const startedAt = Date.now();
    const items = await service.getPublishedNotices();
    const elapsedMs = Date.now() - startedAt;

    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockBlocks).toHaveBeenCalledTimes(2);
    expect(items).toHaveLength(2);
    // Two requests must be at least one interval apart (~3 req/s budget at default).
    // Block-children listings share the same pacing timeline (4 total).
    expect(elapsedMs).toBeGreaterThanOrEqual(440);
  });

  it('honors Retry-After after a 429 and stops querying Notion during the pause', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000_000);
    const service = createService();
    mockQuery.mockResolvedValueOnce(
      queryResponse([notionPage('page-1', publishedProps())]),
    );
    await service.getPublishedNotices(); // seed the snapshot (1 call)

    // Cache expires and Notion answers 429 with Retry-After: 2 seconds.
    nowSpy.mockReturnValue(1_000_000 + 61_000);
    mockQuery.mockResolvedValueOnce(rateLimitResponse('2'));
    await expect(service.getPublishedNotices()).resolves.toHaveLength(1);
    expect(mockQuery).toHaveBeenCalledTimes(2);
    // Let the background flight settle so its 429 backoff is recorded under
    // the current mocked clock before the test advances time again.
    await new Promise((resolve) => setImmediate(resolve));

    // Inside the pause: served from the snapshot without touching Notion.
    nowSpy.mockReturnValue(1_000_000 + 62_000);
    await expect(service.getPublishedNotices()).resolves.toHaveLength(1);
    expect(mockQuery).toHaveBeenCalledTimes(2);

    // After Retry-After elapsed: queries Notion again.
    nowSpy.mockReturnValue(1_000_000 + 64_000);
    mockQuery.mockResolvedValueOnce(
      queryResponse([notionPage('page-1', publishedProps())]),
    );
    await service.getPublishedNotices();
    expect(mockQuery).toHaveBeenCalledTimes(3);
    // Drain the refresh so no mock state leaks into the next test.
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('applies the default cooldown when a 429 has no Retry-After header', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000_000);
    const service = createService();
    mockQuery.mockResolvedValueOnce(rateLimitResponse());

    await expect(service.getPublishedNotices()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(mockQuery).toHaveBeenCalledTimes(1);

    // Still inside the default 1s cooldown: no new Notion call.
    nowSpy.mockReturnValue(1_000_000 + 999);
    await expect(service.getPublishedNotices()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('serves the last good snapshot when Notion fails after a success', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000_000);
    const service = createService();
    mockQuery.mockResolvedValueOnce(
      queryResponse([notionPage('page-1', publishedProps())]),
    );

    const first = await service.getPublishedNotices();

    nowSpy.mockReturnValue(1_000_000 + 61_000);
    mockQuery.mockResolvedValueOnce(
      errorResponse(502, { message: 'bad gateway' }),
    );

    await expect(service.getPublishedNotices()).resolves.toBe(first);
    // Drain the failed background refresh so it cannot disturb later tests.
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('fails with 503 when Notion errors and no snapshot exists', async () => {
    const service = createService();
    mockQuery.mockRejectedValue(new Error('network down'));

    await expect(service.getPublishedNotices()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
