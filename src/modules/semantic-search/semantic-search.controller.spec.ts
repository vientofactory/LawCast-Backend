import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import { Request } from 'express';
import { ApiReadRateLimitService } from '../shared/api-read-rate-limit.service';
import { SemanticSearchController } from './semantic-search.controller';
import { SemanticSearchService } from './semantic-search.service';

describe('SemanticSearchController', () => {
  const createController = () => {
    const searchSemantic =
      jest.fn<(query: string, k: number) => Promise<Record<string, unknown>>>();
    const assertAllowed =
      jest.fn<(req: Request, bucket: string) => Promise<void>>();
    const controller = new SemanticSearchController(
      { searchSemantic } as unknown as SemanticSearchService,
      { assertAllowed } as unknown as ApiReadRateLimitService,
    );
    return { controller, searchSemantic, assertAllowed };
  };

  const req = {} as Request;

  it('rejects a missing or blank query', async () => {
    const { controller } = createController();

    await expect(
      controller.semanticSearch(req, undefined, undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.semanticSearch(req, '   ', undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a query longer than the shared search limit', async () => {
    const { controller } = createController();

    await expect(
      controller.semanticSearch(req, 'x'.repeat(121), undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each(['0', '51', 'abc', '-3', '3.9', '5.0', '1e2', '+5'])(
    'rejects invalid k value %s',
    async (kRaw) => {
      const { controller } = createController();

      await expect(
        controller.semanticSearch(req, '질의', kRaw),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('passes validated parameters through and wraps the response', async () => {
    const { controller, searchSemantic, assertAllowed } = createController();
    searchSemantic.mockResolvedValue({
      query: '질의',
      mode: 'semantic',
      fallbackReason: null,
      results: [],
    });

    const response = await controller.semanticSearch(
      req,
      '  질의  ',
      undefined,
    );

    expect(assertAllowed).toHaveBeenCalledWith(req, 'expensive');
    expect(searchSemantic).toHaveBeenCalledWith('질의', 5);
    expect(response).toEqual({
      success: true,
      data: {
        query: '질의',
        mode: 'semantic',
        fallbackReason: null,
        results: [],
      },
    });
  });

  it('honors an explicit k within range', async () => {
    const { controller, searchSemantic } = createController();
    searchSemantic.mockResolvedValue({
      query: '질의',
      mode: 'semantic',
      fallbackReason: null,
      results: [],
    });

    await controller.semanticSearch(req, '질의', '12');

    expect(searchSemantic).toHaveBeenCalledWith('질의', 12);
  });
});
