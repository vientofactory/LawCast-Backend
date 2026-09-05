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
} from '@nestjs/common';
import type { Request } from 'express';
import { DiscussionsService } from './discussions.service';
import { CreateThreadDto } from './dto/create-thread.dto';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';
import { DeleteCommentDto } from './dto/delete-comment.dto';
import { UpdateThreadStatusDto } from './dto/update-thread-status.dto';
import { ApiResponseUtils } from '../../utils/api-response.utils';
import { IpMaskingUtil } from './utils/ip-masking.util';

@Controller('api')
export class DiscussionsController {
  constructor(private readonly discussionsService: DiscussionsService) {}

  /**
   * 법률안별 토론 스레드 목록 조회
   */
  @Get('notices/:num/discussions')
  async getNoticeThreads(
    @Param('num', ParseIntPipe) noticeNum: number,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
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
   * 법률안 새 토론 스레드 개설 및 #1 의견 등록
   */
  @Post('notices/:num/discussions')
  async createNoticeThread(
    @Param('num', ParseIntPipe) noticeNum: number,
    @Body() dto: CreateThreadDto,
    @Req() req: Request,
  ) {
    const clientIp = IpMaskingUtil.extractClientIp(req);
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
   * 특정 토론 스레드 상세 및 전체 레스 목록 조회
   */
  @Get('discussions/threads/:threadId')
  async getThreadDetail(@Param('threadId', ParseIntPipe) threadId: number) {
    const data = await this.discussionsService.getThreadDetail(threadId);
    return ApiResponseUtils.success(data);
  }

  /**
   * 토론 스레드에 새 의견(#N) 등록
   */
  @Post('discussions/threads/:threadId/comments')
  async addComment(
    @Param('threadId', ParseIntPipe) threadId: number,
    @Body() dto: CreateCommentDto,
    @Req() req: Request,
  ) {
    const clientIp = IpMaskingUtil.extractClientIp(req);
    const data = await this.discussionsService.addComment(
      threadId,
      dto,
      clientIp,
    );
    return ApiResponseUtils.success(data, '의견이 성공적으로 등록되었습니다.');
  }

  /**
   * 의견 수정 (비밀번호 일치 확인)
   */
  @Patch('discussions/comments/:commentId')
  async updateComment(
    @Param('commentId', ParseIntPipe) commentId: number,
    @Body() dto: UpdateCommentDto,
  ) {
    const data = await this.discussionsService.updateComment(commentId, dto);
    return ApiResponseUtils.success(data, '의견이 성공적으로 수정되었습니다.');
  }

  /**
   * 의견 소프트 삭제 (비밀번호 일치 확인)
   */
  @Delete('discussions/comments/:commentId')
  async deleteComment(
    @Param('commentId', ParseIntPipe) commentId: number,
    @Body() dto: DeleteCommentDto,
  ) {
    const data = await this.discussionsService.deleteComment(commentId, dto);
    return ApiResponseUtils.success(data, '의견이 성공적으로 삭제되었습니다.');
  }

  /**
   * 토론 스레드 열림/닫힘 상태 변경 (개설 비밀번호 확인)
   */
  @Patch('discussions/threads/:threadId/status')
  async updateThreadStatus(
    @Param('threadId', ParseIntPipe) threadId: number,
    @Body() dto: UpdateThreadStatusDto,
  ) {
    const data = await this.discussionsService.updateThreadStatus(
      threadId,
      dto,
    );
    return ApiResponseUtils.success(data, '토론 상태가 변경되었습니다.');
  }
}
