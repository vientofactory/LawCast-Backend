import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, LessThan, MoreThan, Repository } from 'typeorm';
import {
  DiscussionThread,
  DiscussionThreadStatus,
} from './entities/discussion-thread.entity';
import {
  DiscussionComment,
  DiscussionMessageType,
} from './entities/discussion-comment.entity';
import { NoticeArchive } from '../notice/notice-archive.entity';
import { CreateThreadDto } from './dto/create-thread.dto';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';
import { DeleteCommentDto } from './dto/delete-comment.dto';
import { UpdateThreadStatusDto } from './dto/update-thread-status.dto';
import { IpMaskingUtil } from './utils/ip-masking.util';
import { PasswordSecurityUtil } from './utils/password-security.util';
import { DiscussionNotificationService } from './discussion-notification.service';

export interface SanitizedComment {
  id: number;
  threadId: number;
  noticeNum: number;
  sequence: number;
  messageType: DiscussionMessageType;
  authorNickname: string;
  authorIpMasked: string;
  content: string;
  isDeleted: boolean;
  isEdited: boolean;
  editedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SanitizedThread {
  id: number;
  noticeNum: number;
  title: string;
  status: DiscussionThreadStatus;
  authorNickname: string;
  authorIpMasked: string;
  commentCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ThreadDetailResponse {
  thread: SanitizedThread;
  comments: SanitizedComment[];
  hasMore: boolean;
  nextCursor: number | null;
}

export interface SanitizedThreadWithNotice extends SanitizedThread {
  noticeSubject: string | null;
}

@Injectable()
export class DiscussionsService {
  private readonly idleCloseHours = Math.max(
    1,
    Number.parseInt(process.env.DISCUSSION_IDLE_CLOSE_HOURS ?? '24', 10) ?? 24,
  );

  constructor(
    @InjectRepository(DiscussionThread)
    private readonly threadRepository: Repository<DiscussionThread>,
    @InjectRepository(DiscussionComment)
    private readonly commentRepository: Repository<DiscussionComment>,
    @InjectRepository(NoticeArchive)
    private readonly noticeArchiveRepository: Repository<NoticeArchive>,
    private readonly dataSource: DataSource,
    @Optional()
    private readonly discussionNotificationService: DiscussionNotificationService,
  ) {}

  async closeIdleThreads(): Promise<number> {
    const cutoff = new Date(Date.now() - this.idleCloseHours * 60 * 60 * 1000);
    const idleThreads = await this.threadRepository.find({
      where: {
        status: DiscussionThreadStatus.OPEN,
        updatedAt: LessThan(cutoff),
      },
    });

    let closedCount = 0;
    for (const thread of idleThreads) {
      await this.dataSource.transaction(async (manager) => {
        const lastComment = await manager.findOne(DiscussionComment, {
          where: { threadId: thread.id },
          order: { sequence: 'DESC' },
        });
        const nextSequence = (lastComment?.sequence || 0) + 1;
        const systemComment = manager.create(
          DiscussionComment,
          this.buildSystemCommentData(
            thread,
            nextSequence,
            `새로운 의견이 ${this.idleCloseHours}시간 동안 등록되지 않아 토론이 자동으로 종료되었습니다.`,
          ),
        );
        await manager.save(DiscussionComment, systemComment);
        await manager.update(DiscussionThread, thread.id, {
          status: DiscussionThreadStatus.CLOSED,
          commentCount: nextSequence,
        });
        closedCount += 1;
      });
    }

    return closedCount;
  }

  private sanitizeComment(comment: DiscussionComment): SanitizedComment {
    return {
      id: comment.id,
      threadId: comment.threadId,
      noticeNum: comment.noticeNum,
      sequence: comment.sequence,
      messageType: comment.messageType,
      authorNickname: comment.authorNickname,
      authorIpMasked: comment.authorIpMasked,
      content: comment.isDeleted
        ? '작성자에 의해 삭제된 의견입니다.'
        : comment.content,
      isDeleted: Boolean(comment.isDeleted),
      isEdited: Boolean(comment.isEdited),
      editedAt: comment.editedAt,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    };
  }

  private sanitizeThread(thread: DiscussionThread): SanitizedThread {
    return {
      id: thread.id,
      noticeNum: thread.noticeNum,
      title: thread.title,
      status: thread.status,
      authorNickname: thread.authorNickname,
      authorIpMasked: thread.authorIpMasked,
      commentCount: thread.commentCount,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    };
  }

  private buildSystemCommentData(
    thread: DiscussionThread,
    sequence: number,
    content: string,
  ): Partial<DiscussionComment> {
    return {
      threadId: thread.id,
      noticeNum: thread.noticeNum,
      sequence,
      messageType: DiscussionMessageType.SYSTEM,
      authorNickname: '시스템',
      authorIpMasked: '',
      authorId: IpMaskingUtil.authorIdFromIp('system', `thread:${thread.id}`),
      passwordHash: '',
      passwordSalt: '',
      content,
      isDeleted: false,
      isEdited: false,
      editedAt: null,
    };
  }

  /**
   * Get paginated discussion threads for a notice.
   */
  async getThreads(
    noticeNum: number,
    page = 1,
    limit = 20,
  ): Promise<{
    items: SanitizedThread[];
    total: number;
    page: number;
    limit: number;
  }> {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, Math.max(1, limit));
    const skip = (safePage - 1) * safeLimit;

    const [threads, total] = await this.threadRepository.findAndCount({
      where: { noticeNum },
      order: { updatedAt: 'DESC' },
      skip,
      take: safeLimit,
    });

    return {
      items: threads.map((t) => this.sanitizeThread(t)),
      total,
      page: safePage,
      limit: safeLimit,
    };
  }

  /**
   * Get paginated discussion threads across all notices, with notice subjects
   * attached, so they can be browsed from a single unified discussions page.
   */
  async getAllThreads(
    page = 1,
    limit = 20,
    status?: DiscussionThreadStatus,
  ): Promise<{
    items: SanitizedThreadWithNotice[];
    total: number;
    page: number;
    limit: number;
  }> {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, Math.max(1, limit));
    const skip = (safePage - 1) * safeLimit;

    const [threads, total] = await this.threadRepository.findAndCount({
      where: status ? { status } : {},
      order: { updatedAt: 'DESC' },
      skip,
      take: safeLimit,
    });

    const noticeNums = Array.from(new Set(threads.map((t) => t.noticeNum)));
    const notices = noticeNums.length
      ? await this.noticeArchiveRepository.find({
          where: { noticeNum: In(noticeNums) },
          select: ['noticeNum', 'subject'],
        })
      : [];
    const subjectByNoticeNum = new Map(
      notices.map((n) => [n.noticeNum, n.subject]),
    );

    return {
      items: threads.map((t) => ({
        ...this.sanitizeThread(t),
        noticeSubject: subjectByNoticeNum.get(t.noticeNum) ?? null,
      })),
      total,
      page: safePage,
      limit: safeLimit,
    };
  }

  /**
   * Get discussion thread detail with all comments in sequence.
   */
  async getThreadDetail(
    threadId: number,
    cursor = 0,
    limit = 20,
  ): Promise<ThreadDetailResponse> {
    const thread = await this.threadRepository.findOne({
      where: { id: threadId },
    });

    if (!thread) {
      throw new NotFoundException('존재하지 않는 토론 스레드입니다.');
    }

    const safeCursor = Math.max(0, cursor);
    const safeLimit = Math.min(100, Math.max(1, limit));
    const comments = await this.commentRepository.find({
      where: { threadId, sequence: MoreThan(safeCursor) },
      order: { sequence: 'ASC' },
      take: safeLimit + 1,
    });
    const hasMore = comments.length > safeLimit;
    const pageComments = hasMore ? comments.slice(0, safeLimit) : comments;

    return {
      thread: this.sanitizeThread(thread),
      comments: pageComments.map((c) => this.sanitizeComment(c)),
      hasMore,
      nextCursor: pageComments[pageComments.length - 1]?.sequence ?? null,
    };
  }

  /**
   * Create a new discussion thread and the initial #1 comment atomically.
   */
  async createThread(
    noticeNum: number,
    dto: CreateThreadDto,
    rawIp: string,
  ): Promise<ThreadDetailResponse> {
    const authorNickname = dto.authorNickname?.trim() || '익명';
    const authorIpMasked = IpMaskingUtil.maskIp(rawIp);
    const { hash: passwordHash, salt: passwordSalt } =
      PasswordSecurityUtil.hashPassword(dto.password);

    return await this.dataSource.transaction(async (manager) => {
      const thread = manager.create(DiscussionThread, {
        noticeNum,
        title: dto.title.trim(),
        status: DiscussionThreadStatus.OPEN,
        authorNickname,
        authorIpMasked,
        authorId: IpMaskingUtil.authorIdFromIp(rawIp, `thread:${noticeNum}`),
        passwordHash,
        passwordSalt,
        commentCount: 1,
      });

      const savedThread = await manager.save(DiscussionThread, thread);
      const authorId = IpMaskingUtil.authorIdFromIp(
        rawIp,
        `thread:${savedThread.id}`,
      );
      await manager.update(DiscussionThread, savedThread.id, { authorId });
      savedThread.authorId = authorId;

      const comment = manager.create(DiscussionComment, {
        threadId: savedThread.id,
        noticeNum,
        sequence: 1,
        messageType: DiscussionMessageType.USER,
        authorNickname,
        authorIpMasked,
        authorId,
        passwordHash,
        passwordSalt,
        content: dto.content.trim(),
        isDeleted: false,
        isEdited: false,
      });

      const savedComment = await manager.save(DiscussionComment, comment);

      return {
        thread: this.sanitizeThread(savedThread),
        comments: [this.sanitizeComment(savedComment)],
        hasMore: false,
        nextCursor: savedComment.sequence,
      };
    });
  }

  /**
   * Add a new comment (#N) to an existing open discussion thread.
   */
  async addComment(
    threadId: number,
    dto: CreateCommentDto,
    rawIp: string,
  ): Promise<SanitizedComment> {
    const authorNickname = dto.authorNickname?.trim() || '익명';
    const authorIpMasked = IpMaskingUtil.maskIp(rawIp);
    const { hash: passwordHash, salt: passwordSalt } =
      PasswordSecurityUtil.hashPassword(dto.password);

    const savedComment = await this.dataSource.transaction(async (manager) => {
      const thread = await manager.findOne(DiscussionThread, {
        where: { id: threadId },
      });

      if (!thread) {
        throw new NotFoundException('존재하지 않는 토론 스레드입니다.');
      }

      if (thread.status === DiscussionThreadStatus.CLOSED) {
        throw new BadRequestException(
          '닫힌 토론에는 새 의견을 작성할 수 없습니다.',
        );
      }

      // Compute next sequence number atomically
      const lastComment = await manager.findOne(DiscussionComment, {
        where: { threadId },
        order: { sequence: 'DESC' },
      });
      const nextSequence = (lastComment?.sequence || 0) + 1;

      const comment = manager.create(DiscussionComment, {
        threadId,
        noticeNum: thread.noticeNum,
        sequence: nextSequence,
        messageType: DiscussionMessageType.USER,
        authorNickname,
        authorIpMasked,
        authorId: IpMaskingUtil.authorIdFromIp(rawIp, `thread:${thread.id}`),
        passwordHash,
        passwordSalt,
        content: dto.content.trim(),
        isDeleted: false,
        isEdited: false,
      });

      const savedComment = await manager.save(DiscussionComment, comment);

      // Update thread comment count and timestamp
      thread.commentCount = nextSequence;
      thread.updatedAt = new Date();
      await manager.save(DiscussionThread, thread);

      return savedComment;
    });

    if (this.discussionNotificationService) {
      void this.discussionNotificationService
        .notifyForQuotes(savedComment)
        .catch((error: unknown) => {
          this.discussionNotificationService?.logDispatchFailure(
            savedComment.id,
            error,
          );
        });
    }

    return this.sanitizeComment(savedComment);
  }

  /**
   * Update a comment's content after verifying password.
   */
  async updateComment(
    commentId: number,
    dto: UpdateCommentDto,
  ): Promise<SanitizedComment> {
    const comment = await this.commentRepository.findOne({
      where: { id: commentId },
    });

    if (!comment) {
      throw new NotFoundException('존재하지 않는 의견입니다.');
    }

    if (comment.messageType === DiscussionMessageType.SYSTEM) {
      throw new BadRequestException('시스템 메시지는 수정할 수 없습니다.');
    }

    if (comment.isDeleted) {
      throw new BadRequestException('이미 삭제된 의견은 수정할 수 없습니다.');
    }

    const isPasswordValid = PasswordSecurityUtil.verifyPassword(
      dto.password,
      comment.passwordSalt,
      comment.passwordHash,
    );

    if (!isPasswordValid) {
      throw new UnauthorizedException('비밀번호가 일치하지 않습니다.');
    }

    comment.content = dto.content.trim();
    comment.isEdited = true;
    comment.editedAt = new Date();

    const saved = await this.commentRepository.save(comment);
    return this.sanitizeComment(saved);
  }

  /**
   * Soft delete a comment after verifying password.
   */
  async deleteComment(
    commentId: number,
    dto: DeleteCommentDto,
  ): Promise<SanitizedComment> {
    const comment = await this.commentRepository.findOne({
      where: { id: commentId },
    });

    if (!comment) {
      throw new NotFoundException('존재하지 않는 의견입니다.');
    }

    if (comment.messageType === DiscussionMessageType.SYSTEM) {
      throw new BadRequestException('시스템 메시지는 삭제할 수 없습니다.');
    }

    if (comment.isDeleted) {
      return this.sanitizeComment(comment);
    }

    const isPasswordValid = PasswordSecurityUtil.verifyPassword(
      dto.password,
      comment.passwordSalt,
      comment.passwordHash,
    );

    if (!isPasswordValid) {
      throw new UnauthorizedException('비밀번호가 일치하지 않습니다.');
    }

    comment.isDeleted = true;
    const saved = await this.commentRepository.save(comment);

    return this.sanitizeComment(saved);
  }

  /**
   * Update thread status (open/closed) after verifying thread author's password.
   */
  async updateThreadStatus(
    threadId: number,
    dto: UpdateThreadStatusDto,
  ): Promise<SanitizedThread> {
    return this.dataSource.transaction(async (manager) => {
      const thread = await manager.findOne(DiscussionThread, {
        where: { id: threadId },
      });

      if (!thread) {
        throw new NotFoundException('존재하지 않는 토론 스레드입니다.');
      }

      const isPasswordValid = PasswordSecurityUtil.verifyPassword(
        dto.password,
        thread.passwordSalt,
        thread.passwordHash,
      );

      if (!isPasswordValid) {
        throw new UnauthorizedException(
          '스레드 개설 비밀번호가 일치하지 않습니다.',
        );
      }

      if (thread.status === dto.status) {
        return this.sanitizeThread(thread);
      }

      const lastComment = await manager.findOne(DiscussionComment, {
        where: { threadId },
        order: { sequence: 'DESC' },
      });
      const nextSequence = (lastComment?.sequence || 0) + 1;
      const action =
        dto.status === DiscussionThreadStatus.CLOSED
          ? '닫혔습니다'
          : '다시 열렸습니다';
      const systemComment = manager.create(
        DiscussionComment,
        this.buildSystemCommentData(
          thread,
          nextSequence,
          `발제자의 요청으로 토론이 ${action}.`,
        ),
      );
      await manager.save(DiscussionComment, systemComment);

      thread.status = dto.status;
      thread.commentCount = nextSequence;
      const saved = await manager.save(DiscussionThread, thread);

      return this.sanitizeThread(saved);
    });
  }
}
