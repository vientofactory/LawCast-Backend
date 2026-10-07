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

  const req = {} as Request;

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

  it('exposes a single GET route and no write endpoints (CRUD stays in Notion)', () => {
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
    ]);

    // The public route naming is /api/announcements.
    const methodPath = Reflect.getMetadata(
      PATH_METADATA,
      AdminNoticesController.prototype.getAdminNotices,
    );
    expect(methodPath).toBe('announcements');
  });
});
