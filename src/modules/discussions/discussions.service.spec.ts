import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { DiscussionsService } from './discussions.service';
import { DiscussionThread } from './entities/discussion-thread.entity';
import { DiscussionComment } from './entities/discussion-comment.entity';
import { UnauthorizedException } from '@nestjs/common';
import { PasswordSecurityUtil } from './utils/password-security.util';

describe('DiscussionsService', () => {
  let service: DiscussionsService;
  let threadRepo: Partial<
    Record<keyof Repository<DiscussionThread>, jest.Mock>
  >;
  let commentRepo: Partial<
    Record<keyof Repository<DiscussionComment>, jest.Mock>
  >;
  let dataSource: { transaction: jest.Mock };

  beforeEach(async () => {
    threadRepo = {
      findAndCount: jest.fn(),
      findOne: jest.fn(),
      save: jest.fn(),
    };
    commentRepo = {
      find: jest.fn(),
      findOne: jest.fn(),
      save: jest.fn(),
    };
    dataSource = {
      transaction: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DiscussionsService,
        {
          provide: getRepositoryToken(DiscussionThread),
          useValue: threadRepo,
        },
        {
          provide: getRepositoryToken(DiscussionComment),
          useValue: commentRepo,
        },
        {
          provide: DataSource,
          useValue: dataSource,
        },
      ],
    }).compile();

    service = module.get<DiscussionsService>(DiscussionsService);
  });

  describe('getThreads', () => {
    it('should return paginated threads with sanitized fields', async () => {
      const mockThreads = [
        {
          id: 1,
          noticeNum: 2200001,
          title: '법안 토론 1',
          status: 'open',
          authorNickname: '홍길동',
          authorIpMasked: '211.234.***.***',
          authorIpHash: 'hash',
          passwordHash: 'secretHash',
          passwordSalt: 'salt',
          commentCount: 3,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      (threadRepo.findAndCount as jest.Mock).mockResolvedValue([
        mockThreads,
        1,
      ]);

      const result = await service.getThreads(2200001, 1, 10);
      expect(result.total).toBe(1);
      expect(result.items[0].title).toBe('법안 토론 1');
      expect((result.items[0] as any).passwordHash).toBeUndefined();
      expect((result.items[0] as any).passwordSalt).toBeUndefined();
      expect((result.items[0] as any).authorIpHash).toBeUndefined();
    });
  });

  describe('createThread', () => {
    it('should create thread and initial comment in a transaction', async () => {
      const mockSavedThread = {
        id: 1,
        noticeNum: 2200001,
        title: '새 토론',
        status: 'open',
        authorNickname: '익명',
        authorIpMasked: '123.45.***.***',
        commentCount: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const mockSavedComment = {
        id: 1,
        threadId: 1,
        noticeNum: 2200001,
        sequence: 1,
        authorNickname: '익명',
        authorIpMasked: '123.45.***.***',
        content: '토론 시작합니다.',
        isDeleted: false,
        isEdited: false,
        editedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      dataSource.transaction.mockImplementation(async (cb) => {
        const manager = {
          create: jest.fn().mockImplementation((_entity, dto) => dto),
          save: jest.fn().mockImplementation((entity) => {
            if (entity === DiscussionThread) return mockSavedThread;
            return mockSavedComment;
          }),
        };
        return cb(manager);
      });

      const result = await service.createThread(
        2200001,
        {
          title: '새 토론',
          content: '토론 시작합니다.',
          password: 'password123',
        },
        '123.45.67.89',
      );

      expect(result.thread.title).toBe('새 토론');
      expect(result.comments).toHaveLength(1);
      expect(result.comments[0].sequence).toBe(1);
      expect(result.comments[0].content).toBe('토론 시작합니다.');
    });
  });

  describe('updateComment', () => {
    it('should throw UnauthorizedException if password does not match', async () => {
      const { hash, salt } =
        PasswordSecurityUtil.hashPassword('correctPassword');
      const mockComment = {
        id: 1,
        passwordHash: hash,
        passwordSalt: salt,
        content: '기존 내용',
        isDeleted: false,
      };

      (commentRepo.findOne as jest.Mock).mockResolvedValue(mockComment);

      await expect(
        service.updateComment(1, {
          password: 'wrongPassword',
          content: '수정할 내용',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should update content and mark isEdited if password matches', async () => {
      const { hash, salt } =
        PasswordSecurityUtil.hashPassword('correctPassword');
      const mockComment = {
        id: 1,
        passwordHash: hash,
        passwordSalt: salt,
        content: '기존 내용',
        isDeleted: false,
        isEdited: false,
        editedAt: null,
      };

      (commentRepo.findOne as jest.Mock).mockResolvedValue(mockComment);
      (commentRepo.save as jest.Mock).mockImplementation((c) =>
        Promise.resolve(c),
      );

      const updated = await service.updateComment(1, {
        password: 'correctPassword',
        content: '수정된 내용',
      });

      expect(updated.content).toBe('수정된 내용');
      expect(updated.isEdited).toBe(true);
    });
  });

  describe('deleteComment', () => {
    it('should soft delete comment when password matches and return sanitized comment', async () => {
      const { hash, salt } = PasswordSecurityUtil.hashPassword('deletePass');
      const mockComment = {
        id: 1,
        threadId: 1,
        noticeNum: 2200001,
        sequence: 1,
        authorNickname: '익명',
        authorIpMasked: '123.45.***.***',
        content: '원문 내용',
        passwordHash: hash,
        passwordSalt: salt,
        isDeleted: false,
        isEdited: false,
        editedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      (commentRepo.findOne as jest.Mock).mockResolvedValue(mockComment);
      (commentRepo.save as jest.Mock).mockResolvedValue({
        ...mockComment,
        isDeleted: true,
      });

      const res = await service.deleteComment(1, { password: 'deletePass' });
      expect(res.isDeleted).toBe(true);
      expect(res.content).toBe('작성자에 의해 삭제된 의견입니다.');
      expect(mockComment.isDeleted).toBe(true);
    });
  });
});
