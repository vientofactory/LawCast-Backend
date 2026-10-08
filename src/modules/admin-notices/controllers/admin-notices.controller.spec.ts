import { RequestMethod, ServiceUnavailableException } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, jest } from '@jest/globals';
import { Request } from 'express';
import { ApiReadRateLimitService } from '../../shared/api-read-rate-limit.service';
import { AdminNoticesService } from '../admin-notices.service';
import { AdminNoticesController } from './admin-notices.controller';

describe('AdminNoticesController', () => {
  const createController = () => {
    const getPublishedNotices = jest.fn<() => Promise<unknown[]>>();
    const assertAllowed =
      jest.fn<(req: Request, bucket?: string) => Promise<void>>();
    const controller = new AdminNoticesController(
      { getPublishedNotices } as unknown as AdminNoticesService,
      { assertAllowed } as unknown as ApiReadRateLimitService,
    );
    return { controller, getPublishedNotices, assertAllowed };
  };

  // Express always populates req.query — mirror that in the fixture.
  const req = { query: {} } as Request;

  it('rate-limits the request and wraps the notice list', async () => {
    const { controller, getPublishedNotices, assertAllowed } =
      createController();
    getPublishedNotices.mockResolvedValue([
      { id: 'page-1', title: '공지', published: true },
    ]);

    const response = await controller.getAdminNotices(req);

    expect(assertAllowed).toHaveBeenCalledWith(req);
    expect(getPublishedNotices).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      success: true,
      data: {
        items: [{ id: 'page-1', title: '공지', published: true }],
      },
    });
  });

  it('propagates service failures instead of masking them', async () => {
    const { controller, getPublishedNotices } = createController();
    getPublishedNotices.mockRejectedValue(
      new ServiceUnavailableException('공지사항을 불러오지 못했습니다.'),
    );

    await expect(controller.getAdminNotices(req)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('serves only the top display-order notice from GET announcements/top', async () => {
    const { controller, getPublishedNotices, assertAllowed } =
      createController();
    const notices = [
      {
        id: 'page-1',
        title: '1위 공지',
        urgent: false,
        content: '긴 본문 미리보기',
        body: '## 마크다운 본문',
      },
      { id: 'page-2', title: '2위 공지', urgent: true },
    ];
    getPublishedNotices.mockResolvedValue(notices);

    const response = await controller.getTopAdminNotice(req);

    expect(assertAllowed).toHaveBeenCalledWith(req);
    expect(getPublishedNotices).toHaveBeenCalledTimes(1);
    // Cap-1 view: content/body never leave the endpoint, even when present.
    expect(response).toEqual({
      success: true,
      data: { item: { id: 'page-1', title: '1위 공지' } },
    });
  });

  it('serves the first urgent notice in display order with urgent=true', async () => {
    const { controller, getPublishedNotices } = createController();
    const notices = [
      { id: 'page-1', title: '보통 공지', urgent: false },
      { id: 'page-2', title: '긴급 공지', urgent: true },
      { id: 'page-3', title: '긴급 공지 2', urgent: true },
    ];
    getPublishedNotices.mockResolvedValue(notices);

    const response = await controller.getTopAdminNotice({
      query: { urgent: 'true' },
    } as unknown as Request);

    expect(response).toEqual({
      success: true,
      data: { item: { id: 'page-2', title: '긴급 공지' } },
    });
  });

  it('returns a null item when no notice matches the selection', async () => {
    const { controller, getPublishedNotices } = createController();

    // Empty board: both selections come back null, never a thrown error.
    getPublishedNotices.mockResolvedValue([]);
    await expect(controller.getTopAdminNotice(req)).resolves.toEqual({
      success: true,
      data: { item: null },
    });

    // urgent=true with no urgent row marked: null as well.
    getPublishedNotices.mockResolvedValue([
      { id: 'page-1', title: '보통 공지', urgent: false },
    ]);
    await expect(
      controller.getTopAdminNotice({
        query: { urgent: 'true' },
      } as unknown as Request),
    ).resolves.toEqual({ success: true, data: { item: null } });
  });

  it('exposes read-only GET routes (list + top) and no write endpoints (CRUD stays in Notion)', () => {
    const routePath = Reflect.getMetadata(
      PATH_METADATA,
      AdminNoticesController,
    );
    expect(routePath).toBe('api');

    const methodKeys = Object.getOwnPropertyNames(
      AdminNoticesController.prototype,
    ).filter((key) => key !== 'constructor');

    const mappedMethods = methodKeys.map((key) => ({
      key,
      method: Reflect.getMetadata(
        METHOD_METADATA,
        AdminNoticesController.prototype[key],
      ),
    }));

    expect(mappedMethods).toEqual([
      { key: 'getAdminNotices', method: RequestMethod.GET },
      { key: 'getTopAdminNotice', method: RequestMethod.GET },
    ]);

    // The public routes are /api/announcements (list) and
    // /api/announcements/top (single cap-1 notice).
    const listPath = Reflect.getMetadata(
      PATH_METADATA,
      AdminNoticesController.prototype.getAdminNotices,
    );
    expect(listPath).toBe('announcements');
    const topPath = Reflect.getMetadata(
      PATH_METADATA,
      AdminNoticesController.prototype.getTopAdminNotice,
    );
    expect(topPath).toBe('announcements/top');
  });
});
