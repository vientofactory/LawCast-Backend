import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DiscussionsController } from './discussions.controller';
import { DiscussionsService } from '../discussions.service';
import { DiscussionsRateLimitService } from '../discussions-rate-limit.service';
import { DiscussionThreadStatus } from '../entities/discussion-thread.entity';
import type { Request } from 'express';

describe('DiscussionsController', () => {
  let controller: DiscussionsController;
  let service: Partial<Record<keyof DiscussionsService, jest.Mock>>;
  let rateLimitService: { assertAllowed: jest.Mock };

  beforeEach(async () => {
    service = {
      getThreads: jest.fn(),
      getAllThreads: jest.fn(),
      createThread: jest.fn(),
      getThreadDetail: jest.fn(),
      addComment: jest.fn(),
      updateComment: jest.fn(),
      deleteComment: jest.fn(),
      updateThreadStatus: jest.fn(),
    };
    rateLimitService = { assertAllowed: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DiscussionsController],
      providers: [
        { provide: DiscussionsService, useValue: service },
        { provide: DiscussionsRateLimitService, useValue: rateLimitService },
      ],
    }).compile();

    controller = module.get<DiscussionsController>(DiscussionsController);
  });

  describe('getNoticeThreads', () => {
    it('should return wrapped success response with thread list', async () => {
      const mockResult = { items: [], total: 0, page: 1, limit: 20 };
      (service.getThreads as jest.Mock).mockResolvedValue(mockResult);

      const res = await controller.getNoticeThreads(
        2200001,
        {} as Request,
        '1',
        '20',
      );
      expect(res.success).toBe(true);
      expect(res.data).toEqual(mockResult);
      expect(service.getThreads).toHaveBeenCalledWith(2200001, 1, 20);
      expect(rateLimitService.assertAllowed).toHaveBeenCalledWith(
        expect.anything(),
        'read',
        'notice-threads',
      );
    });
  });

  describe('getAllThreads', () => {
    it('should return wrapped success response with cross-notice thread list', async () => {
      const mockResult = { items: [], total: 0, page: 1, limit: 20 };
      (service.getAllThreads as jest.Mock).mockResolvedValue(mockResult);

      const res = await controller.getAllThreads({} as Request, '1', '20');
      expect(res.success).toBe(true);
      expect(res.data).toEqual(mockResult);
      expect(service.getAllThreads).toHaveBeenCalledWith(1, 20, undefined);
      expect(rateLimitService.assertAllowed).toHaveBeenCalledWith(
        expect.anything(),
        'read',
        'all-threads',
      );
    });

    it('should forward a valid status filter to the service', async () => {
      const mockResult = { items: [], total: 0, page: 1, limit: 20 };
      (service.getAllThreads as jest.Mock).mockResolvedValue(mockResult);

      await controller.getAllThreads({} as Request, '1', '20', 'open' as any);
      expect(service.getAllThreads).toHaveBeenCalledWith(1, 20, 'open');
    });

    it('should ignore an invalid status filter', async () => {
      const mockResult = { items: [], total: 0, page: 1, limit: 20 };
      (service.getAllThreads as jest.Mock).mockResolvedValue(mockResult);

      await controller.getAllThreads({} as Request, '1', '20', 'bogus' as any);
      expect(service.getAllThreads).toHaveBeenCalledWith(1, 20, undefined);
    });
  });

  describe('createNoticeThread', () => {
    it('should extract client IP and call service.createThread', async () => {
      const mockResult = { thread: { id: 1, title: '토론' }, comments: [] };
      (service.createThread as jest.Mock).mockResolvedValue(mockResult);
      const mockReq = {
        headers: { 'cf-connecting-ip': '211.234.1.2' },
      } as unknown as Request;
      const dto = {
        title: '토론 주제',
        password: 'password123',
        content: '내용입니다.',
      };

      const res = await controller.createNoticeThread(2200001, dto, mockReq);
      expect(res.success).toBe(true);
      expect(res.data).toEqual(mockResult);
      expect(service.createThread).toHaveBeenCalledWith(
        2200001,
        dto,
        '211.234.1.2',
      );
    });

    it('should reject the request when the client IP cannot be extracted', async () => {
      const dto = {
        title: '토론 주제',
        password: 'password123',
        content: '내용입니다.',
      };

      await expect(
        controller.createNoticeThread(2200001, dto, {
          headers: {},
        } as unknown as Request),
      ).rejects.toMatchObject({ status: 400 });
      expect(service.createThread).not.toHaveBeenCalled();
    });
  });

  describe('addComment', () => {
    it('should add comment to thread with extracted IP', async () => {
      const mockComment = { id: 2, sequence: 2, content: '답글' };
      (service.addComment as jest.Mock).mockResolvedValue(mockComment);
      const mockReq = {
        headers: { 'x-forwarded-for': '123.45.67.89' },
      } as unknown as Request;
      const dto = { password: 'password123', content: '답글입니다.' };

      const res = await controller.addComment(1, dto, mockReq);
      expect(res.success).toBe(true);
      expect(res.data).toEqual(mockComment);
      expect(service.addComment).toHaveBeenCalledWith(1, dto, '123.45.67.89');
    });

    it('should reject the request when the client IP cannot be extracted', async () => {
      const dto = { password: 'password123', content: '답글입니다.' };

      await expect(
        controller.addComment(1, dto, {
          headers: {},
        } as unknown as Request),
      ).rejects.toMatchObject({ status: 400 });
      expect(service.addComment).not.toHaveBeenCalled();
    });
  });

  describe('updateComment', () => {
    it('should call service.updateComment', async () => {
      const mockComment = { id: 1, content: '수정됨' };
      (service.updateComment as jest.Mock).mockResolvedValue(mockComment);
      const dto = { password: 'pass', content: '수정됨' };

      const res = await controller.updateComment(1, dto, {} as Request);
      expect(res.success).toBe(true);
      expect(res.data).toEqual(mockComment);
    });
  });

  describe('deleteComment', () => {
    it('should call service.deleteComment', async () => {
      const mockDeleted = {
        id: 1,
        isDeleted: true,
        content: '작성자에 의해 삭제된 의견입니다.',
      };
      (service.deleteComment as jest.Mock).mockResolvedValue(mockDeleted);
      const dto = { password: 'pass' };

      const res = await controller.deleteComment(1, dto, {} as Request);
      expect(res.success).toBe(true);
      expect(res.data).toEqual(mockDeleted);
      expect(res.message).toBe('의견이 성공적으로 삭제되었습니다.');
    });
  });

  describe('rate limiting enforcement', () => {
    it('should check read rate limit before listing threads', async () => {
      (service.getThreads as jest.Mock).mockResolvedValue({
        items: [],
        total: 0,
        page: 1,
        limit: 20,
      });

      await controller.getNoticeThreads(2200001, {} as Request, '1', '20');
      expect(rateLimitService.assertAllowed).toHaveBeenCalledWith(
        expect.anything(),
        'read',
        'notice-threads',
      );
    });

    it('should check write rate limit before creating a thread', async () => {
      const mockResult = { thread: { id: 1 }, comments: [] };
      (service.createThread as jest.Mock).mockResolvedValue(mockResult);
      const mockReq = {
        headers: { 'cf-connecting-ip': '1.2.3.4' },
      } as unknown as Request;

      await controller.createNoticeThread(
        2200001,
        { title: 't', password: 'p', content: 'c' },
        mockReq,
      );
      expect(rateLimitService.assertAllowed).toHaveBeenCalledWith(
        expect.anything(),
        'write',
      );
    });

    it('should check write rate limit before adding a comment', async () => {
      (service.addComment as jest.Mock).mockResolvedValue({ id: 1 });
      const mockReq = {
        headers: { 'cf-connecting-ip': '1.2.3.4' },
      } as unknown as Request;

      await controller.addComment(1, { password: 'p', content: 'c' }, mockReq);
      expect(rateLimitService.assertAllowed).toHaveBeenCalledWith(
        expect.anything(),
        'write',
      );
    });

    it('should check write rate limit before updating a comment', async () => {
      (service.updateComment as jest.Mock).mockResolvedValue({ id: 1 });

      await controller.updateComment(
        1,
        { password: 'p', content: 'c' },
        {} as Request,
      );
      expect(rateLimitService.assertAllowed).toHaveBeenCalledWith(
        expect.anything(),
        'write',
      );
    });

    it('should check write rate limit before deleting a comment', async () => {
      (service.deleteComment as jest.Mock).mockResolvedValue({
        id: 1,
        isDeleted: true,
      });

      await controller.deleteComment(1, { password: 'p' }, {} as Request);
      expect(rateLimitService.assertAllowed).toHaveBeenCalledWith(
        expect.anything(),
        'write',
      );
    });

    it('should check write rate limit before updating thread status', async () => {
      (service.updateThreadStatus as jest.Mock).mockResolvedValue({
        id: 1,
        status: 'closed',
      });

      await controller.updateThreadStatus(
        1,
        { status: DiscussionThreadStatus.CLOSED, password: 'p' },
        {} as Request,
      );
      expect(rateLimitService.assertAllowed).toHaveBeenCalledWith(
        expect.anything(),
        'write',
      );
    });

    it('should check read rate limit for thread detail', async () => {
      (service.getThreadDetail as jest.Mock).mockResolvedValue({
        thread: {},
        comments: [],
        hasMore: false,
        nextCursor: null,
      });

      await controller.getThreadDetail(1, undefined, undefined, {} as Request);
      expect(rateLimitService.assertAllowed).toHaveBeenCalledWith(
        expect.anything(),
        'read',
        'thread-detail',
      );
    });
  });

  describe('error propagation', () => {
    it('should propagate service errors without swallowing them', async () => {
      (service.getThreads as jest.Mock).mockRejectedValue(
        new Error('database connection lost'),
      );

      await expect(
        controller.getNoticeThreads(2200001, {} as Request, '1', '20'),
      ).rejects.toThrow('database connection lost');
    });

    it('should propagate rate limit errors from the service', async () => {
      (service.createThread as jest.Mock).mockRejectedValue(
        new BadRequestException('존재하지 않는 의안번호입니다.'),
      );
      const mockReq = {
        headers: { 'cf-connecting-ip': '1.2.3.4' },
      } as unknown as Request;

      await expect(
        controller.createNoticeThread(
          999999,
          { title: 't', password: 'p', content: 'c' },
          mockReq,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
