import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { DiscussionsService } from './discussions.service';
import {
  DiscussionThread,
  DiscussionThreadStatus,
} from './entities/discussion-thread.entity';
import {
  DiscussionComment,
  DiscussionMessageType,
} from './entities/discussion-comment.entity';
import { NoticeArchive } from '../notice/notice-archive.entity';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { PasswordSecurityUtil } from './utils/password-security.util';

describe('DiscussionsService', () => {
  beforeAll(() => {
    process.env.DISCUSSION_AUTHOR_ID_SECRET = 'test-author-id-secret';
  });
  let service: DiscussionsService;
  let threadRepo: Partial<
    Record<keyof Repository<DiscussionThread>, jest.Mock>
  >;
  let commentRepo: Partial<
    Record<keyof Repository<DiscussionComment>, jest.Mock>
  >;
  let noticeArchiveRepo: Partial<
    Record<keyof Repository<NoticeArchive>, jest.Mock>
  >;
  let dataSource: { transaction: jest.Mock };

  beforeEach(async () => {
    threadRepo = {
      findAndCount: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
    };
    commentRepo = {
      find: jest.fn(),
      findOne: jest.fn(),
      save: jest.fn(),
    };
    noticeArchiveRepo = {
      find: jest.fn(),
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
          provide: getRepositoryToken(NoticeArchive),
          useValue: noticeArchiveRepo,
        },
        {
          provide: DataSource,
          useValue: dataSource,
        },
      ],
    }).compile();

    service = module.get<DiscussionsService>(DiscussionsService);
  });

  describe('closeIdleThreads', () => {
    it('closes only open threads older than the idle threshold', async () => {
      const idleThreads = [
        { id: 1, noticeNum: 2200001 },
        { id: 2, noticeNum: 2200002 },
        { id: 3, noticeNum: 2200003 },
      ];
      (threadRepo.find as jest.Mock).mockResolvedValue(idleThreads);
      dataSource.transaction.mockImplementation(async (callback) =>
        callback({
          findOne: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockImplementation((_entity, value) => value),
          save: jest.fn().mockResolvedValue(undefined),
          update: jest.fn().mockResolvedValue({ affected: 1 }),
        }),
      );

      const affected = await service.closeIdleThreads();

      expect(affected).toBe(3);
      expect(dataSource.transaction).toHaveBeenCalledTimes(3);
    });

    it('returns zero when no stale threads are found', async () => {
      (threadRepo.find as jest.Mock).mockResolvedValue([]);

      await expect(service.closeIdleThreads()).resolves.toBe(0);
    });
  });

  describe('getThreads', () => {
    it('should return paginated threads with sanitized fields', async () => {
      const mockThreads = [
        {
          id: 1,
          noticeNum: 2200001,
          title: '법안 토론 1',
          status: DiscussionThreadStatus.OPEN,
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
      expect(threadRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          order: { updatedAt: 'DESC', id: 'DESC' },
        }),
      );
      expect((result.items[0] as any).passwordHash).toBeUndefined();
      expect((result.items[0] as any).passwordSalt).toBeUndefined();
      expect((result.items[0] as any).authorIpHash).toBeUndefined();
    });
  });

  describe('getAllThreads', () => {
    it('should attach notice subjects across multiple notices', async () => {
      const mockThreads = [
        {
          id: 1,
          noticeNum: 2200001,
          title: '법안 토론 1',
          status: DiscussionThreadStatus.OPEN,
          authorNickname: '홍길동',
          authorIpMasked: '211.234.***.***',
          commentCount: 3,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 2,
          noticeNum: 2200002,
          title: '법안 토론 2',
          status: DiscussionThreadStatus.CLOSED,
          authorNickname: '익명',
          authorIpMasked: '123.45.***.***',
          commentCount: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      (threadRepo.findAndCount as jest.Mock).mockResolvedValue([
        mockThreads,
        2,
      ]);
      (noticeArchiveRepo.find as jest.Mock).mockResolvedValue([
        { noticeNum: 2200001, subject: '첫 번째 법률안' },
        { noticeNum: 2200002, subject: '두 번째 법률안' },
      ]);

      const result = await service.getAllThreads(1, 20);

      expect(result.total).toBe(2);
      expect(result.items[0].noticeSubject).toBe('첫 번째 법률안');
      expect(result.items[1].noticeSubject).toBe('두 번째 법률안');
    });

    it('should filter by status when provided', async () => {
      (threadRepo.findAndCount as jest.Mock).mockResolvedValue([[], 0]);
      (noticeArchiveRepo.find as jest.Mock).mockResolvedValue([]);

      await service.getAllThreads(1, 20, DiscussionThreadStatus.OPEN);

      expect(threadRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: DiscussionThreadStatus.OPEN },
          order: { updatedAt: 'DESC', id: 'DESC' },
        }),
      );
    });

    it('should return null notice subject when the notice is not found', async () => {
      (threadRepo.findAndCount as jest.Mock).mockResolvedValue([
        [
          {
            id: 1,
            noticeNum: 2200099,
            title: '삭제된 법률안 토론',
            status: DiscussionThreadStatus.OPEN,
            authorNickname: '익명',
            authorIpMasked: '123.45.***.***',
            commentCount: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        1,
      ]);
      (noticeArchiveRepo.find as jest.Mock).mockResolvedValue([]);

      const result = await service.getAllThreads(1, 20);

      expect(result.items[0].noticeSubject).toBeNull();
    });
  });

  describe('createThread', () => {
    it('should create thread and initial comment in a transaction', async () => {
      const mockSavedThread = {
        id: 1,
        noticeNum: 2200001,
        title: '새 토론',
        status: DiscussionThreadStatus.OPEN,
        authorNickname: '익명',
        authorId: 'test-author-id',
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
        authorId: 'test-author-id',
        authorIpMasked: '123.45.***.***',
        content: '토론 시작합니다.',
        isDeleted: false,
        isEdited: false,
        editedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const create = jest.fn().mockImplementation((_entity, dto) => dto);

      dataSource.transaction.mockImplementation(async (cb) => {
        const manager = {
          create,
          update: jest.fn(),
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
      expect(result.comments[0]).not.toHaveProperty('authorIpHash');
      expect(result.comments[0].content).toBe('토론 시작합니다.');
    });
  });

  describe('addComment', () => {
    it('returns the saved comment without waiting for quote notifications', async () => {
      let resolveNotification!: () => void;
      const notificationPromise = new Promise<void>((resolve) => {
        resolveNotification = resolve;
      });
      const notifyForQuotes = jest.fn().mockReturnValue(notificationPromise);
      const logDispatchFailure = jest.fn();
      (service as any).discussionNotificationService = {
        notifyForQuotes,
        logDispatchFailure,
      };

      const thread = {
        id: 7,
        noticeNum: 2200001,
        status: DiscussionThreadStatus.OPEN,
        commentCount: 1,
        updatedAt: new Date(),
      };
      const savedComment = {
        id: 8,
        threadId: 7,
        noticeNum: 2200001,
        sequence: 2,
        messageType: DiscussionMessageType.USER,
        authorNickname: '테스터',
        authorIpMasked: '127.0.***.***',
        authorId: 'author-2',
        content: '새 의견입니다.',
        isDeleted: false,
        isEdited: false,
        editedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const manager = {
        findOne: jest
          .fn()
          .mockResolvedValueOnce(thread)
          .mockResolvedValueOnce({ sequence: 1 }),
        create: jest.fn().mockImplementation((_entity, value) => value),
        save: jest
          .fn()
          .mockResolvedValueOnce(savedComment)
          .mockResolvedValueOnce(thread),
      };
      dataSource.transaction.mockImplementation(async (callback) =>
        callback(manager),
      );

      const result = await service.addComment(
        7,
        { password: 'password123', content: '새 의견입니다.' },
        '127.0.0.1',
      );

      expect(result.id).toBe(8);
      expect(notifyForQuotes).toHaveBeenCalledWith(savedComment);
      expect(logDispatchFailure).not.toHaveBeenCalled();

      resolveNotification();
    });
  });

  describe('getThreadDetail', () => {
    it('should return one comment page and the next sequence cursor', async () => {
      const thread = {
        id: 1,
        noticeNum: 2200001,
        title: '페이지 토론',
        status: DiscussionThreadStatus.OPEN,
        authorNickname: '익명',
        authorIpMasked: '123.45.***.***',
        commentCount: 3,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const comments = [1, 2, 3].map((sequence) => ({
        id: sequence,
        threadId: 1,
        noticeNum: 2200001,
        sequence,
        messageType: DiscussionMessageType.USER,
        authorNickname: '익명',
        authorIpMasked: '123.45.***.***',
        content: `의견 ${sequence}`,
        isDeleted: false,
        isEdited: false,
        editedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));

      (threadRepo.findOne as jest.Mock).mockResolvedValue(thread);
      (commentRepo.find as jest.Mock).mockResolvedValue(comments);

      const result = await service.getThreadDetail(1, 0, 2);

      expect(commentRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ take: 3, order: { sequence: 'ASC' } }),
      );
      expect(result.comments.map((comment) => comment.sequence)).toEqual([
        1, 2,
      ]);
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBe(2);
    });
  });

  describe('updateComment', () => {
    it('should reject edits to a system message', async () => {
      const mockComment = {
        id: 1,
        messageType: DiscussionMessageType.SYSTEM,
        isDeleted: false,
      };

      (commentRepo.findOne as jest.Mock).mockResolvedValue(mockComment);

      await expect(
        service.updateComment(1, {
          password: 'any-password',
          content: '수정 시도',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(commentRepo.save).not.toHaveBeenCalled();
    });

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
    it('should reject deletion of a system message', async () => {
      const mockComment = {
        id: 1,
        messageType: DiscussionMessageType.SYSTEM,
        isDeleted: false,
      };

      (commentRepo.findOne as jest.Mock).mockResolvedValue(mockComment);

      await expect(
        service.deleteComment(1, { password: 'any-password' }),
      ).rejects.toThrow(BadRequestException);
      expect(commentRepo.save).not.toHaveBeenCalled();
    });

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

  describe('updateThreadStatus', () => {
    it.each([
      [
        DiscussionThreadStatus.OPEN,
        DiscussionThreadStatus.CLOSED,
        '닫혔습니다',
      ],
      [
        DiscussionThreadStatus.CLOSED,
        DiscussionThreadStatus.OPEN,
        '다시 열렸습니다',
      ],
    ])(
      'appends a system message when changing %s to %s',
      async (currentStatus, nextStatus, expectedAction) => {
        const { hash, salt } = PasswordSecurityUtil.hashPassword('threadPass');
        const thread = {
          id: 1,
          noticeNum: 2200001,
          status: currentStatus,
          passwordHash: hash,
          passwordSalt: salt,
          authorNickname: '익명',
          authorIpMasked: '123.45.***.***',
          commentCount: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        const manager = {
          findOne: jest
            .fn()
            .mockResolvedValueOnce(thread)
            .mockResolvedValueOnce({ sequence: 1 }),
          create: jest.fn().mockImplementation((_entity, value) => value),
          save: jest.fn().mockImplementation((_entity, value) => value),
        };
        dataSource.transaction.mockImplementation(async (callback) =>
          callback(manager),
        );

        const result = await service.updateThreadStatus(1, {
          status: nextStatus,
          password: 'threadPass',
        });

        expect(result.status).toBe(nextStatus);
        expect(manager.create).toHaveBeenCalledWith(
          DiscussionComment,
          expect.objectContaining({
            messageType: DiscussionMessageType.SYSTEM,
            sequence: 2,
            content: `발제자의 요청으로 토론이 ${expectedAction}.`,
          }),
        );
      },
    );
  });
});
