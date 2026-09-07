import { Repository } from 'typeorm';
import { DiscussionNotificationService } from './discussion-notification.service';
import {
  DiscussionComment,
  DiscussionMessageType,
} from './entities/discussion-comment.entity';

describe('DiscussionNotificationService', () => {
  it('notifies active subscriptions for referenced participants only', async () => {
    const commentRepository = {
      find: jest.fn().mockResolvedValue([
        {
          id: 1,
          threadId: 7,
          noticeNum: 100,
          sequence: 1,
          messageType: DiscussionMessageType.USER,
          authorId: 'author-1',
          authorNickname: '첫 작성자',
          isDeleted: false,
        },
        {
          id: 2,
          threadId: 7,
          noticeNum: 100,
          sequence: 2,
          messageType: DiscussionMessageType.SYSTEM,
          authorId: 'system',
          isDeleted: false,
        },
      ]),
    } as unknown as Repository<DiscussionComment>;
    const subscriptionService = {
      findActiveForDiscussionAuthor: jest.fn().mockResolvedValue([{ id: 11 }]),
    };
    const webPushService = {
      sendQuoteBatch: jest.fn().mockResolvedValue(undefined),
    };
    const service = new DiscussionNotificationService(
      commentRepository,
      subscriptionService as any,
      webPushService as any,
    );

    await service.notifyForQuotes({
      id: 3,
      threadId: 7,
      noticeNum: 100,
      sequence: 3,
      messageType: DiscussionMessageType.USER,
      authorId: 'author-2',
      authorNickname: '두 번째 작성자',
      content: '>>#1 의견에 답합니다. >>#2는 제외되어야 합니다.',
    } as DiscussionComment);

    expect(
      subscriptionService.findActiveForDiscussionAuthor,
    ).toHaveBeenCalledWith(7, 'author-1');
    expect(webPushService.sendQuoteBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        noticeNum: 100,
        threadId: 7,
        quotedSequence: 1,
        quotingSequence: 3,
        quotingCommentId: 3,
        quotingCommentContent:
          '>>#1 의견에 답합니다. >>#2는 제외되어야 합니다.',
      }),
      [{ id: 11 }],
    );
    expect(webPushService.sendQuoteBatch).toHaveBeenCalledTimes(1);
  });

  it('does not notify when a participant quotes their own opinion', async () => {
    const commentRepository = {
      find: jest.fn().mockResolvedValue([
        {
          sequence: 1,
          messageType: DiscussionMessageType.USER,
          authorId: 'same-author',
          isDeleted: false,
        },
      ]),
    } as unknown as Repository<DiscussionComment>;
    const subscriptionService = {
      findActiveForDiscussionAuthor: jest.fn(),
    };
    const webPushService = { sendQuoteBatch: jest.fn() };
    const service = new DiscussionNotificationService(
      commentRepository,
      subscriptionService as any,
      webPushService as any,
    );

    await service.notifyForQuotes({
      id: 2,
      threadId: 7,
      noticeNum: 100,
      messageType: DiscussionMessageType.USER,
      authorId: 'same-author',
      content: '>>#1 다시 확인합니다.',
    } as DiscussionComment);

    expect(webPushService.sendQuoteBatch).not.toHaveBeenCalled();
  });
});
