import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import {
  DiscussionThread,
  type DiscussionThreadStatus,
} from './entities/discussion-thread.entity';
import { DiscussionComment } from './entities/discussion-comment.entity';
import { CreateThreadDto } from './dto/create-thread.dto';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';
import { DeleteCommentDto } from './dto/delete-comment.dto';
import { UpdateThreadStatusDto } from './dto/update-thread-status.dto';
import { IpMaskingUtil } from './utils/ip-masking.util';
import { PasswordSecurityUtil } from './utils/password-security.util';

export interface SanitizedComment {
  id: number;
  threadId: number;
  noticeNum: number;
  sequence: number;
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
}

@Injectable()
export class DiscussionsService {
  constructor(
    @InjectRepository(DiscussionThread)
    private readonly threadRepository: Repository<DiscussionThread>,
    @InjectRepository(DiscussionComment)
    private readonly commentRepository: Repository<DiscussionComment>,
    private readonly dataSource: DataSource,
  ) {}

  private sanitizeComment(comment: DiscussionComment): SanitizedComment {
    return {
      id: comment.id,
      threadId: comment.threadId,
      noticeNum: comment.noticeNum,
      sequence: comment.sequence,
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
   * Get discussion thread detail with all comments in sequence.
   */
  async getThreadDetail(threadId: number): Promise<ThreadDetailResponse> {
    const thread = await this.threadRepository.findOne({
      where: { id: threadId },
    });

    if (!thread) {
      throw new NotFoundException('존재하지 않는 토론 스레드입니다.');
    }

    const comments = await this.commentRepository.find({
      where: { threadId },
      order: { sequence: 'ASC' },
    });

    return {
      thread: this.sanitizeThread(thread),
      comments: comments.map((c) => this.sanitizeComment(c)),
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
    const authorIpHash = IpMaskingUtil.hashIp(rawIp);
    const { hash: passwordHash, salt: passwordSalt } =
      PasswordSecurityUtil.hashPassword(dto.password);

    return await this.dataSource.transaction(async (manager) => {
      const thread = manager.create(DiscussionThread, {
        noticeNum,
        title: dto.title.trim(),
        status: 'open',
        authorNickname,
        authorIpMasked,
        authorIpHash,
        passwordHash,
        passwordSalt,
        commentCount: 1,
      });

      const savedThread = await manager.save(DiscussionThread, thread);

      const comment = manager.create(DiscussionComment, {
        threadId: savedThread.id,
        noticeNum,
        sequence: 1,
        authorNickname,
        authorIpMasked,
        authorIpHash,
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
    const authorIpHash = IpMaskingUtil.hashIp(rawIp);
    const { hash: passwordHash, salt: passwordSalt } =
      PasswordSecurityUtil.hashPassword(dto.password);

    return await this.dataSource.transaction(async (manager) => {
      const thread = await manager.findOne(DiscussionThread, {
        where: { id: threadId },
      });

      if (!thread) {
        throw new NotFoundException('존재하지 않는 토론 스레드입니다.');
      }

      if (thread.status === 'closed') {
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
        authorNickname,
        authorIpMasked,
        authorIpHash,
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

      return this.sanitizeComment(savedComment);
    });
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
  ): Promise<{ success: boolean; message: string }> {
    const comment = await this.commentRepository.findOne({
      where: { id: commentId },
    });

    if (!comment) {
      throw new NotFoundException('존재하지 않는 의견입니다.');
    }

    if (comment.isDeleted) {
      return { success: true, message: '이미 삭제된 의견입니다.' };
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
    await this.commentRepository.save(comment);

    return { success: true, message: '의견이 성공적으로 삭제되었습니다.' };
  }

  /**
   * Update thread status (open/closed) after verifying thread author's password.
   */
  async updateThreadStatus(
    threadId: number,
    dto: UpdateThreadStatusDto,
  ): Promise<SanitizedThread> {
    const thread = await this.threadRepository.findOne({
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

    thread.status = dto.status;
    const saved = await this.threadRepository.save(thread);

    return this.sanitizeThread(saved);
  }
}
