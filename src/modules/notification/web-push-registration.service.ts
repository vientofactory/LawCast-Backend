import { Injectable, NotFoundException } from '@nestjs/common';
import { Request } from 'express';
import { HashguardService } from '../shared/hashguard.service';
import { WebhookValidationUtils } from '../../utils/webhook-validation.utils';
import { ApiResponseUtils, ErrorContext } from '../../utils/api-response.utils';
import { CreateWebPushSubscriptionDto } from './dto/create-web-push-subscription.dto';
import { RemoveWebPushSubscriptionDto } from './dto/remove-web-push-subscription.dto';
import { WebPushSubscriptionService } from './web-push-subscription.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DiscussionThread } from '../discussions/entities/discussion-thread.entity';
import { IpMaskingUtil } from '../discussions/utils/ip-masking.util';

@Injectable()
export class WebPushRegistrationService {
  constructor(
    private readonly hashguardService: HashguardService,
    private readonly webPushSubscriptionService: WebPushSubscriptionService,
    @InjectRepository(DiscussionThread)
    private readonly discussionThreadRepository: Repository<DiscussionThread>,
  ) {}

  async registerSubscription(
    createDto: CreateWebPushSubscriptionDto,
    req: Request,
  ) {
    try {
      const clientIp = WebhookValidationUtils.extractClientIp(req);
      const isProofValid = await this.hashguardService.verifyProof(
        createDto.proof,
        clientIp,
      );

      if (!isProofValid) {
        throw ApiResponseUtils.createPoWFailedException();
      }

      let discussionAuthorId: string | undefined;
      if (createDto.threadId !== undefined) {
        const thread = await this.discussionThreadRepository.findOne({
          where: { id: createDto.threadId },
        });
        if (!thread) {
          throw new NotFoundException('존재하지 않는 토론 스레드입니다.');
        }

        discussionAuthorId = IpMaskingUtil.authorIdFromIp(
          clientIp,
          `thread:${thread.id}`,
        );
      }

      const subscription =
        await this.webPushSubscriptionService.createOrReactivate({
          endpoint: createDto.endpoint,
          p256dh: createDto.p256dh,
          auth: createDto.auth,
          userAgent: req.headers['user-agent'] ?? null,
          noticeNotificationsEnabled: createDto.threadId === undefined,
        });

      if (createDto.threadId !== undefined) {
        await this.webPushSubscriptionService.bindToDiscussion(
          subscription.id,
          createDto.threadId,
          discussionAuthorId as string,
        );
      }

      return ApiResponseUtils.success(
        { id: subscription.id },
        '웹 푸시 알림 구독이 등록되었습니다.',
      );
    } catch (error) {
      ApiResponseUtils.handleError(error, ErrorContext.NOTIFICATION);
    }
  }

  async unregisterSubscription(removeDto: RemoveWebPushSubscriptionDto) {
    try {
      await this.webPushSubscriptionService.deleteByEndpoint(
        removeDto.endpoint,
      );
      return ApiResponseUtils.success(
        { success: true },
        '웹 푸시 알림 구독이 해지되었습니다.',
      );
    } catch (error) {
      ApiResponseUtils.handleError(error, ErrorContext.NOTIFICATION);
    }
  }
}
