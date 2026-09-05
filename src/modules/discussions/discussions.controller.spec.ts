import { Test, TestingModule } from '@nestjs/testing';
import { DiscussionsController } from './discussions.controller';
import { DiscussionsService } from './discussions.service';
import type { Request } from 'express';

describe('DiscussionsController', () => {
  let controller: DiscussionsController;
  let service: Partial<Record<keyof DiscussionsService, jest.Mock>>;

  beforeEach(async () => {
    service = {
      getThreads: jest.fn(),
      createThread: jest.fn(),
      getThreadDetail: jest.fn(),
      addComment: jest.fn(),
      updateComment: jest.fn(),
      deleteComment: jest.fn(),
      updateThreadStatus: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DiscussionsController],
      providers: [
        {
          provide: DiscussionsService,
          useValue: service,
        },
      ],
    }).compile();

    controller = module.get<DiscussionsController>(DiscussionsController);
  });

  describe('getNoticeThreads', () => {
    it('should return wrapped success response with thread list', async () => {
      const mockResult = {
        items: [],
        total: 0,
        page: 1,
        limit: 20,
      };
      (service.getThreads as jest.Mock).mockResolvedValue(mockResult);

      const res = await controller.getNoticeThreads(2200001, '1', '20');
      expect(res.success).toBe(true);
      expect(res.data).toEqual(mockResult);
      expect(service.getThreads).toHaveBeenCalledWith(2200001, 1, 20);
    });
  });

  describe('createNoticeThread', () => {
    it('should extract client IP and call service.createThread', async () => {
      const mockResult = {
        thread: { id: 1, title: '토론' },
        comments: [],
      };
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
  });

  describe('addComment', () => {
    it('should add comment to thread with extracted IP', async () => {
      const mockComment = {
        id: 2,
        sequence: 2,
        content: '답글',
      };
      (service.addComment as jest.Mock).mockResolvedValue(mockComment);

      const mockReq = {
        headers: { 'x-forwarded-for': '123.45.67.89' },
      } as unknown as Request;

      const dto = {
        password: 'password123',
        content: '답글입니다.',
      };

      const res = await controller.addComment(1, dto, mockReq);
      expect(res.success).toBe(true);
      expect(res.data).toEqual(mockComment);
      expect(service.addComment).toHaveBeenCalledWith(1, dto, '123.45.67.89');
    });
  });

  describe('updateComment', () => {
    it('should call service.updateComment', async () => {
      const mockComment = { id: 1, content: '수정됨' };
      (service.updateComment as jest.Mock).mockResolvedValue(mockComment);

      const dto = { password: 'pass', content: '수정됨' };
      const res = await controller.updateComment(1, dto);
      expect(res.success).toBe(true);
      expect(res.data).toEqual(mockComment);
    });
  });

  describe('deleteComment', () => {
    it('should call service.deleteComment', async () => {
      (service.deleteComment as jest.Mock).mockResolvedValue({
        success: true,
        message: '의견이 성공적으로 삭제되었습니다.',
      });

      const dto = { password: 'pass' };
      const res = await controller.deleteComment(1, dto);
      expect(res.success).toBe(true);
      expect(res.message).toBe('의견이 성공적으로 삭제되었습니다.');
    });
  });
});
