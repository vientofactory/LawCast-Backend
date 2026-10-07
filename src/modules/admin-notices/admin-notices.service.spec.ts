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
import axios, { AxiosError } from 'axios';
import { AdminNoticesService } from './admin-notices.service';
import { NOTION_PROPERTY } from './admin-notices.constants';

jest.mock('axios');

describe('AdminNoticesService', () => {
  const mockPost =
    jest.fn<(url: string, body?: unknown) => Promise<{ data: unknown }>>();
  const mockGet =
    jest.fn<(url: string, config?: unknown) => Promise<{ data: unknown }>>();
  const mockedAxios = axios as jest.Mocked<typeof axios>;

  const createService = (
    overrides: Record<string, unknown> = {},
  ): AdminNoticesService => {
    mockedAxios.create.mockReturnValue({ post: mockPost, get: mockGet } as any);
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

  const notionPage = (
    id: string,
    properties: Record<string, unknown>,
  ): Record<string, unknown> => ({ id, properties });

  const queryResponse = (
    results: Record<string, unknown>[],
    extra: Record<string, unknown> = {},
  ) => ({ data: { results, has_more: false, next_cursor: null, ...extra } });

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
  beforeEach(() => {
    jest.clearAllMocks();
    // Drop any queued one-time implementations from a previous test so an
    // unconsumed Once value can never leak into (and corrupt) the next test.
    mockPost.mockReset();
    mockGet.mockReset();
    // Block-children listings default to a page without a block body; tests
    // that exercise the Markdown body override it with realistic payloads.
    mockGet.mockResolvedValue({
      data: { results: [], has_more: false, next_cursor: null },
    });
    mockedAxios.isAxiosError.mockImplementation(
      (payload: any): payload is AxiosError<any, any, any> =>
        Boolean(payload?.isAxiosError),
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('configures the Notion client with bearer auth and version header', () => {
    createService();

    expect(mockedAxios.create).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://api.notion.com',
        timeout: 5000,
        headers: expect.objectContaining({
          Authorization: 'Bearer secret-token',
          'Notion-Version': '2022-06-28',
        }),
      }),
    );
  });

  it('returns an empty list without calling Notion when unconfigured', async () => {
    const service = createService({ 'notion.apiKey': '' });

    await expect(service.getPublishedNotices()).resolves.toEqual([]);
    expect(mockPost).not.toHaveBeenCalled();

    const noDatabase = createService({ 'notion.databaseId': '' });
    await expect(noDatabase.getPublishedNotices()).resolves.toEqual([]);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('queries only published rows and maps title/status/order/urgent/content', async () => {
    const service = createService();
    mockPost.mockResolvedValue(
      queryResponse([
        notionPage('page-1', publishedProps()),
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

    expect(mockPost).toHaveBeenCalledWith('/v1/databases/db-123/query', {
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
      },
    ]);
    // Only displayable (published + titled) rows get their block tree read.
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(mockGet.mock.calls.map((call) => call[0])).toEqual([
      '/v1/blocks/page-1/children',
      '/v1/blocks/page-2/children',
    ]);
  });

  it('converts a page block body into markdown via notion-to-md', async () => {
    const service = createService();
    mockPost.mockResolvedValue(
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
    mockGet.mockResolvedValue({
      data: {
        results: [
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
        ],
        has_more: false,
        next_cursor: null,
      },
    });

    const items = await service.getPublishedNotices();

    expect(mockGet).toHaveBeenCalledWith('/v1/blocks/page-1/children', {
      params: {},
    });
    expect(items).toHaveLength(1);
    expect(items[0].content).toBe('');
    expect(items[0].body).toContain('# 마크다운 테스트');
    expect(items[0].body).toContain('- asdf\n- qwer');
    expect(items[0].body).toContain('**볼드체**');
  });

  it('keeps serving notices when one block body conversion fails', async () => {
    const service = createService();
    mockPost.mockResolvedValue(
      queryResponse([notionPage('page-1', publishedProps())]),
    );
    mockGet.mockRejectedValue(new Error('network down'));

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
    mockPost.mockResolvedValue(
      queryResponse([notionPage('page-1', publishedProps())]),
    );
    mockGet.mockRejectedValue({
      isAxiosError: true,
      message: 'rate limited',
      response: { status: 429 },
    });

    await expect(service.getPublishedNotices()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledTimes(1);

    // Inside the default 1s cooldown: block fetches are Notion requests too,
    // so the whole board stops querying instead of hammering through 429s.
    nowSpy.mockReturnValue(1_000_000 + 999);
    await expect(service.getPublishedNotices()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('orders by 노출 순서 ascending with missing order last', async () => {
    const service = createService();
    mockPost.mockResolvedValue(
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
    mockPost
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

    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(mockPost.mock.calls[1][1]).toEqual(
      expect.objectContaining({ start_cursor: 'cursor-1' }),
    );
    expect(items.map((item) => item.id)).toEqual(['page-1', 'page-2']);
  });

  it('serves the fresh cache without re-querying Notion', async () => {
    const service = createService();
    mockPost.mockResolvedValue(
      queryResponse([notionPage('page-1', publishedProps())]),
    );

    const first = await service.getPublishedNotices();
    const second = await service.getPublishedNotices();

    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('re-queries after the cache TTL expires', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000_000);
    const service = createService();
    mockPost.mockResolvedValue(
      queryResponse([notionPage('page-1', publishedProps())]),
    );

    await service.getPublishedNotices();
    nowSpy.mockReturnValue(1_000_000 + 61_000);
    await service.getPublishedNotices();

    expect(mockPost).toHaveBeenCalledTimes(2);
  });

  it('serves the stale snapshot immediately and refreshes in the background', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000_000);
    const service = createService();
    mockPost.mockResolvedValueOnce(
      queryResponse([notionPage('page-1', publishedProps())]),
    );
    const first = await service.getPublishedNotices(); // seed the snapshot

    // TTL expired: the next read answers from the snapshot at once (the
    // request must not wait for Notion) and kicks off the refresh.
    nowSpy.mockReturnValue(1_000_000 + 61_000);
    mockPost.mockResolvedValueOnce(
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
    expect(mockPost).toHaveBeenCalledTimes(2); // background fetch started

    // Let the background flight settle: the next request serves the refresh.
    await new Promise((resolve) => setImmediate(resolve));
    const refreshed = await service.getPublishedNotices();

    expect(refreshed).not.toBe(first);
    expect(refreshed.map((item) => item.title)).toEqual(['갱신된 공지']);
    expect(mockPost).toHaveBeenCalledTimes(2); // cache is fresh again
  });

  it('collapses concurrent stale reads into one background refresh', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000_000);
    const service = createService();
    mockPost.mockResolvedValueOnce(
      queryResponse([notionPage('page-1', publishedProps())]),
    );
    await service.getPublishedNotices(); // seed the snapshot

    nowSpy.mockReturnValue(1_000_000 + 61_000);
    mockPost.mockResolvedValue(
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
    expect(mockPost).toHaveBeenCalledTimes(2); // 1 seed + 1 background
    // Let the background flight settle before the next test starts.
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('honors the cache TTL injected via NOTION_CACHE_TTL_MS', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000_000);
    const service = createService({ 'notion.cacheTtlMs': 10_000 });
    mockPost.mockResolvedValue(
      queryResponse([notionPage('page-1', publishedProps())]),
    );

    await service.getPublishedNotices();
    nowSpy.mockReturnValue(1_000_000 + 5_000);
    await service.getPublishedNotices();
    // Still inside the injected TTL: served from cache.
    expect(mockPost).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(1_000_000 + 10_000);
    await service.getPublishedNotices();
    // The injected TTL (10s, shorter than the 60s default) expired: refetched.
    expect(mockPost).toHaveBeenCalledTimes(2);
  });

  it('falls back to the default TTL when NOTION_CACHE_TTL_MS is not set', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000_000);
    const service = createService({ 'notion.cacheTtlMs': undefined });
    mockPost.mockResolvedValue(
      queryResponse([notionPage('page-1', publishedProps())]),
    );

    await service.getPublishedNotices();
    nowSpy.mockReturnValue(1_000_000 + 59_000);
    await service.getPublishedNotices();
    expect(mockPost).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(1_000_000 + 60_000);
    await service.getPublishedNotices();
    expect(mockPost).toHaveBeenCalledTimes(2);
  });

  it('shares one Notion fetch across concurrent cache misses (single-flight)', async () => {
    const service = createService();
    mockPost.mockResolvedValue(
      queryResponse([notionPage('page-1', publishedProps())]),
    );

    const [first, second, third] = await Promise.all([
      service.getPublishedNotices(),
      service.getPublishedNotices(),
      service.getPublishedNotices(),
    ]);

    // A visitor burst must collapse into one Notion query sequence.
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('spaces consecutive Notion requests by the configured minimum interval', async () => {
    const service = createService({ 'notion.minRequestIntervalMs': 150 });
    mockPost
      .mockResolvedValueOnce(
        queryResponse([notionPage('page-1', publishedProps())], {
          has_more: true,
          next_cursor: 'cursor-1',
        }),
      )
      .mockResolvedValueOnce(
        queryResponse([
          notionPage('page-2', {
            ...publishedProps({
              [NOTION_PROPERTY.ORDER]: { type: 'number', number: 2 },
            }),
          }),
        ]),
      );

    const startedAt = Date.now();
    const items = await service.getPublishedNotices();
    const elapsedMs = Date.now() - startedAt;

    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(items).toHaveLength(2);
    // Two requests must be at least one interval apart (~3 req/s budget at default).
    // Block-children listings share the same pacing timeline (4 total).
    expect(elapsedMs).toBeGreaterThanOrEqual(440);
  });

  it('honors Retry-After after a 429 and stops querying Notion during the pause', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000_000);
    const service = createService();
    mockPost.mockResolvedValueOnce(
      queryResponse([notionPage('page-1', publishedProps())]),
    );
    await service.getPublishedNotices(); // seed the snapshot (1 call)

    // Cache expires and Notion answers 429 with Retry-After: 2 seconds.
    nowSpy.mockReturnValue(1_000_000 + 61_000);
    mockPost.mockRejectedValueOnce({
      isAxiosError: true,
      message: 'rate limited',
      response: { status: 429, headers: { 'retry-after': '2' } },
    });
    await expect(service.getPublishedNotices()).resolves.toHaveLength(1);
    expect(mockPost).toHaveBeenCalledTimes(2);
    // Let the background flight settle so its 429 backoff is recorded under
    // the current mocked clock before the test advances time again.
    await new Promise((resolve) => setImmediate(resolve));

    // Inside the pause: served from the snapshot without touching Notion.
    nowSpy.mockReturnValue(1_000_000 + 62_000);
    await expect(service.getPublishedNotices()).resolves.toHaveLength(1);
    expect(mockPost).toHaveBeenCalledTimes(2);

    // After Retry-After elapsed: queries Notion again.
    nowSpy.mockReturnValue(1_000_000 + 64_000);
    mockPost.mockResolvedValueOnce(
      queryResponse([notionPage('page-1', publishedProps())]),
    );
    await service.getPublishedNotices();
    expect(mockPost).toHaveBeenCalledTimes(3);
    // Drain the refresh so no mock state leaks into the next test.
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('applies the default cooldown when a 429 has no Retry-After header', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000_000);
    const service = createService();
    mockPost.mockRejectedValueOnce({
      isAxiosError: true,
      message: 'rate limited',
      response: { status: 429 },
    });

    await expect(service.getPublishedNotices()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(mockPost).toHaveBeenCalledTimes(1);

    // Still inside the default 1s cooldown: no new Notion call.
    nowSpy.mockReturnValue(1_000_000 + 999);
    await expect(service.getPublishedNotices()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('serves the last good snapshot when Notion fails after a success', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000_000);
    const service = createService();
    mockPost.mockResolvedValueOnce(
      queryResponse([notionPage('page-1', publishedProps())]),
    );

    const first = await service.getPublishedNotices();

    nowSpy.mockReturnValue(1_000_000 + 61_000);
    mockPost.mockRejectedValueOnce({
      isAxiosError: true,
      message: 'connect ECONNREFUSED',
      response: { status: 502, data: { message: 'bad gateway' } },
    });

    await expect(service.getPublishedNotices()).resolves.toBe(first);
    // Drain the failed background refresh so it cannot disturb later tests.
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('fails with 503 when Notion errors and no snapshot exists', async () => {
    const service = createService();
    mockPost.mockRejectedValue(new Error('network down'));

    await expect(service.getPublishedNotices()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
