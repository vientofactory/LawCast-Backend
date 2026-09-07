import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WebPushNotificationService } from '../notification/web-push-notification.service';
import { WebPushSubscriptionService } from '../notification/web-push-subscription.service';
import {
  DiscussionComment,
  DiscussionMessageType,
} from './entities/discussion-comment.entity';
import { QuoteDetectionUtil } from './utils/quote-detection.util';

@Injectable()
export class DiscussionNotificationService {
  private readonly logger = new Logger(DiscussionNotificationService.name);

  constructor(
    @InjectRepository(DiscussionComment)
    private readonly commentRepository: Repository<DiscussionComment>,
    private readonly webPushSubscriptionService: WebPushSubscriptionService,
    private readonly webPushNotificationService: WebPushNotificationService,
  ) {}

  async notifyForQuotes(comment: DiscussionComment): Promise<void> {
    const referencedSequences = QuoteDetectionUtil.extractReferencedSequences(
      comment.content,
    );
    if (referencedSequences.length === 0) return;

    const comments = await this.commentRepository.find({
      where: { threadId: comment.threadId },
    });
    const referencedComments = comments.filter(
      (candidate) =>
        referencedSequences.includes(candidate.sequence) &&
        candidate.messageType === DiscussionMessageType.USER &&
        !candidate.isDeleted &&
        candidate.authorId !== comment.authorId,
    );

    for (const referencedComment of referencedComments) {
      const subscriptions =
        await this.webPushSubscriptionService.findActiveForDiscussionAuthor(
          comment.threadId,
          referencedComment.authorId,
        );
      await this.webPushNotificationService.sendQuoteBatch(
        {
          noticeNum: comment.noticeNum,
          threadId: comment.threadId,
          quotedSequence: referencedComment.sequence,
          quotingCommentId: comment.id,
          quotingAuthorNickname: comment.authorNickname,
        },
        subscriptions,
      );
    }
  }

  logDispatchFailure(commentId: number, error: unknown): void {
    this.logger.warn(
      `Quote notification failed for comment ${commentId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
