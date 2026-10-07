import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseFilters,
} from '@nestjs/common';
import type { Request } from 'express';
import { DiscussionsService } from '../discussions.service';
import { DiscussionThreadStatus } from '../entities/discussion-thread.entity';
import { CreateThreadDto } from '../dto/create-thread.dto';
import { CreateCommentDto } from '../dto/create-comment.dto';
import { UpdateCommentDto } from '../dto/update-comment.dto';
import { DeleteCommentDto } from '../dto/delete-comment.dto';
import { UpdateThreadStatusDto } from '../dto/update-thread-status.dto';
import { ApiResponseUtils } from '../../../utils/api-response.utils';
import { IpMaskingUtil } from '../utils/ip-masking.util';
import { DiscussionsRateLimitService } from '../discussions-rate-limit.service';
import { DiscussionsRateLimitFilter } from './discussions-rate-limit.filter';

@Controller('api')
@UseFilters(DiscussionsRateLimitFilter)
export class DiscussionsController {
  constructor(
    private readonly discussionsService: DiscussionsService,
    private readonly rateLimitService: DiscussionsRateLimitService,
  ) {}

  /**
   * Lists discussion threads for one legislative notice.
   */
  @Get('notices/:num/discussions')
  async getNoticeThreads(
    @Param('num', ParseIntPipe) noticeNum: number,
    @Req() req: Request,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    await this.rateLimitService.assertAllowed(req, 'read', 'notice-threads');
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 20;

    const data = await this.discussionsService.getThreads(
      noticeNum,
      pageNum,
      limitNum,
    );
    return ApiResponseUtils.success(data);
  }

  /**
   * Lists discussion threads across all legislative notices.
   */
  @Get('discussions/threads')
  async getAllThreads(
    @Req() req: Request,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: DiscussionThreadStatus,
  ) {
    await this.rateLimitService.assertAllowed(req, 'read', 'all-threads');
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 20;
    const safeStatus =
      status === DiscussionThreadStatus.OPEN ||
      status === DiscussionThreadStatus.CLOSED
        ? status
        : undefined;

    const data = await this.discussionsService.getAllThreads(
      pageNum,
      limitNum,
      safeStatus,
    );
    return ApiResponseUtils.success(data);
  }

  /**
   * Opens a new discussion thread and registers its first comment (#1).
   */
  @Post('notices/:num/discussions')
  async createNoticeThread(
    @Param('num', ParseIntPipe) noticeNum: number,
    @Body() dto: CreateThreadDto,
    @Req() req: Request,
  ) {
    await this.rateLimitService.assertAllowed(req, 'write');
    const clientIp = IpMaskingUtil.requireClientIp(req);
    const data = await this.discussionsService.createThread(
      noticeNum,
      dto,
      clientIp,
    );
    return ApiResponseUtils.success(
      data,
      '토론 스레드가 성공적으로 개설되었습니다.',
    );
  }

  /**
   * Returns one thread's detail with its full comment list.
   */
  @Get('discussions/threads/:threadId')
  async getThreadDetail(
    @Param('threadId', ParseIntPipe) threadId: number,
    @Query('cursor') cursorParam: string | undefined,
    @Query('limit') limitParam: string | undefined,
    @Req() req: Request,
  ) {
    await this.rateLimitService.assertAllowed(req, 'read', 'thread-detail');
    const cursor = cursorParam ? Number.parseInt(cursorParam, 10) : 0;
    const limit = limitParam ? Number.parseInt(limitParam, 10) : 20;
    const data = await this.discussionsService.getThreadDetail(
      threadId,
      Number.isFinite(cursor) ? cursor : 0,
      Number.isFinite(limit) ? limit : 20,
    );
    return ApiResponseUtils.success(data);
  }

  /**
   * Registers a new comment (#N) on a thread.
   */
  @Post('discussions/threads/:threadId/comments')
  async addComment(
    @Param('threadId', ParseIntPipe) threadId: number,
    @Body() dto: CreateCommentDto,
    @Req() req: Request,
  ) {
    await this.rateLimitService.assertAllowed(req, 'write');
    const clientIp = IpMaskingUtil.requireClientIp(req);
    const data = await this.discussionsService.addComment(
      threadId,
      dto,
      clientIp,
    );
    return ApiResponseUtils.success(data, '의견이 성공적으로 등록되었습니다.');
  }

  /**
   * Updates a comment (password match required).
   */
  @Patch('discussions/comments/:commentId')
  async updateComment(
    @Param('commentId', ParseIntPipe) commentId: number,
    @Body() dto: UpdateCommentDto,
    @Req() req: Request,
  ) {
    await this.rateLimitService.assertAllowed(req, 'write');
    const data = await this.discussionsService.updateComment(commentId, dto);
    return ApiResponseUtils.success(data, '의견이 성공적으로 수정되었습니다.');
  }

  /**
   * Soft-deletes a comment (password match required).
   */
  @Delete('discussions/comments/:commentId')
  async deleteComment(
    @Param('commentId', ParseIntPipe) commentId: number,
    @Body() dto: DeleteCommentDto,
    @Req() req: Request,
  ) {
    await this.rateLimitService.assertAllowed(req, 'write');
    const data = await this.discussionsService.deleteComment(commentId, dto);
    return ApiResponseUtils.success(data, '의견이 성공적으로 삭제되었습니다.');
  }

  /**
   * Toggles a thread between open/closed (creation password required).
   */
  @Patch('discussions/threads/:threadId/status')
  async updateThreadStatus(
    @Param('threadId', ParseIntPipe) threadId: number,
    @Body() dto: UpdateThreadStatusDto,
    @Req() req: Request,
  ) {
    await this.rateLimitService.assertAllowed(req, 'write');
    const data = await this.discussionsService.updateThreadStatus(
      threadId,
      dto,
    );
    return ApiResponseUtils.success(data, '토론 상태가 변경되었습니다.');
  }
}
