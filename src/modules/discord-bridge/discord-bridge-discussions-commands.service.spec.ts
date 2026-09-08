import { DiscordBridgeDiscussionsCommandsService } from './discord-bridge-discussions-commands.service';
import { DiscussionThreadStatus } from '../discussions/entities/discussion-thread.entity';
import { DiscussionMessageType } from '../discussions/entities/discussion-comment.entity';

describe('DiscordBridgeDiscussionsCommandsService', () => {
  function createService(discussionsService: Record<string, jest.Mock>) {
    const moduleRef = {
      get: jest.fn().mockReturnValue(discussionsService),
    };
    const service = new DiscordBridgeDiscussionsCommandsService(
      moduleRef as any,
    );
    return { service, moduleRef };
  }

  describe('executeCommand', () => {
    it('ignores commands that are not discussion-admin', async () => {
      const { service } = createService({});
      const interaction = { commandName: 'status' } as any;

      await expect(service.executeCommand(interaction)).resolves.toBe(false);
    });

    it('renders the panel for the list subcommand', async () => {
      const discussionsService = {
        getAllThreads: jest.fn().mockResolvedValue({
          items: [
            {
              id: 1,
              noticeNum: 2200001,
              noticeSubject: '테스트 법률안',
              title: '토론 제목',
              status: DiscussionThreadStatus.OPEN,
              commentCount: 3,
              updatedAt: new Date(),
            },
          ],
          total: 1,
          page: 1,
          limit: 5,
        }),
      };
      const { service } = createService(discussionsService);
      const reply = jest.fn().mockResolvedValue(undefined);
      const interaction = {
        commandName: 'discussion-admin',
        options: {
          getSubcommand: () => 'list',
          getString: () => null,
          getInteger: () => null,
        },
        reply,
      } as any;

      const handled = await service.executeCommand(interaction);

      expect(handled).toBe(true);
      expect(discussionsService.getAllThreads).toHaveBeenCalledWith(
        1,
        5,
        undefined,
      );
      expect(reply).toHaveBeenCalledTimes(1);
      const replyArgs = reply.mock.calls[0][0];
      expect(replyArgs.components).toHaveLength(1);
    });

    it('force-closes a thread via the close subcommand', async () => {
      const discussionsService = {
        adminSetThreadStatus: jest.fn().mockResolvedValue({
          id: 7,
          title: '닫을 토론',
          status: DiscussionThreadStatus.CLOSED,
        }),
      };
      const { service } = createService(discussionsService);
      const reply = jest.fn().mockResolvedValue(undefined);
      const interaction = {
        commandName: 'discussion-admin',
        options: {
          getSubcommand: () => 'close',
          getInteger: () => 7,
        },
        reply,
      } as any;

      await service.executeCommand(interaction);

      expect(discussionsService.adminSetThreadStatus).toHaveBeenCalledWith(
        7,
        DiscussionThreadStatus.CLOSED,
      );
      expect(reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('#7') }),
      );
    });

    it('hides a comment via the hide-comment subcommand', async () => {
      const discussionsService = {
        adminHideComment: jest.fn().mockResolvedValue({
          id: 99,
          threadId: 7,
          sequence: 3,
        }),
      };
      const { service } = createService(discussionsService);
      const reply = jest.fn().mockResolvedValue(undefined);
      const interaction = {
        commandName: 'discussion-admin',
        options: {
          getSubcommand: () => 'hide-comment',
          getInteger: () => 99,
        },
        reply,
      } as any;

      await service.executeCommand(interaction);

      expect(discussionsService.adminHideComment).toHaveBeenCalledWith(99);
      expect(reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('#99') }),
      );
    });

    it('locks a thread via the lock subcommand', async () => {
      const discussionsService = {
        adminSetThreadLock: jest.fn().mockResolvedValue({
          id: 7,
          title: '잠글 토론',
          isLocked: true,
        }),
      };
      const { service } = createService(discussionsService);
      const reply = jest.fn().mockResolvedValue(undefined);
      const interaction = {
        commandName: 'discussion-admin',
        options: {
          getSubcommand: () => 'lock',
          getInteger: () => 7,
        },
        reply,
      } as any;

      await service.executeCommand(interaction);

      expect(discussionsService.adminSetThreadLock).toHaveBeenCalledWith(
        7,
        true,
      );
      expect(reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('#7') }),
      );
    });

    it('unlocks a thread via the unlock subcommand', async () => {
      const discussionsService = {
        adminSetThreadLock: jest.fn().mockResolvedValue({
          id: 7,
          title: '잠금 해제할 토론',
          isLocked: false,
        }),
      };
      const { service } = createService(discussionsService);
      const reply = jest.fn().mockResolvedValue(undefined);
      const interaction = {
        commandName: 'discussion-admin',
        options: {
          getSubcommand: () => 'unlock',
          getInteger: () => 7,
        },
        reply,
      } as any;

      await service.executeCommand(interaction);

      expect(discussionsService.adminSetThreadLock).toHaveBeenCalledWith(
        7,
        false,
      );
    });

    it('posts an admin message via the post-message subcommand', async () => {
      const discussionsService = {
        adminPostMessage: jest.fn().mockResolvedValue({
          id: 200,
          threadId: 7,
          sequence: 5,
        }),
      };
      const { service } = createService(discussionsService);
      const reply = jest.fn().mockResolvedValue(undefined);
      const interaction = {
        commandName: 'discussion-admin',
        options: {
          getSubcommand: () => 'post-message',
          getInteger: () => 7,
          getString: (name: string) =>
            name === 'message' ? '공지 내용' : '법제사법위원회',
        },
        reply,
      } as any;

      await service.executeCommand(interaction);

      expect(discussionsService.adminPostMessage).toHaveBeenCalledWith(
        7,
        '공지 내용',
        '법제사법위원회',
      );
      expect(reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('#7') }),
      );
    });
  });

  describe('executeComponentInteraction', () => {
    it('ignores buttons that do not use the discussion admin prefix', async () => {
      const { service } = createService({});
      const interaction = {
        isButton: () => true,
        isStringSelectMenu: () => false,
        customId: 'other:action',
      } as any;

      await expect(
        service.executeComponentInteraction(interaction),
      ).resolves.toBe(false);
    });

    it('paginates the thread list on a page button', async () => {
      const discussionsService = {
        getAllThreads: jest.fn().mockResolvedValue({
          items: [],
          total: 0,
          page: 2,
          limit: 5,
        }),
      };
      const { service } = createService(discussionsService);
      const update = jest.fn().mockResolvedValue(undefined);
      const interaction = {
        isButton: () => true,
        isStringSelectMenu: () => false,
        customId: 'da:page:2:-',
        update,
      } as any;

      const handled = await service.executeComponentInteraction(interaction);

      expect(handled).toBe(true);
      expect(discussionsService.getAllThreads).toHaveBeenCalledWith(
        2,
        5,
        undefined,
      );
      expect(update).toHaveBeenCalledTimes(1);
    });

    it('toggles a thread from open to closed and re-renders the detail view', async () => {
      const discussionsService = {
        getThreadDetail: jest
          .fn()
          .mockResolvedValueOnce({
            thread: { id: 5, status: DiscussionThreadStatus.OPEN },
            comments: [],
            hasMore: false,
            nextCursor: null,
          })
          .mockResolvedValueOnce({
            thread: {
              id: 5,
              status: DiscussionThreadStatus.CLOSED,
              title: '토론',
              noticeNum: 1,
              commentCount: 1,
            },
            comments: [],
            hasMore: false,
            nextCursor: null,
          }),
        adminSetThreadStatus: jest.fn().mockResolvedValue({}),
      };
      const { service } = createService(discussionsService);
      const update = jest.fn().mockResolvedValue(undefined);
      const interaction = {
        isButton: () => true,
        isStringSelectMenu: () => false,
        customId: 'da:toggle:5:0:1:-',
        update,
      } as any;

      await service.executeComponentInteraction(interaction);

      expect(discussionsService.adminSetThreadStatus).toHaveBeenCalledWith(
        5,
        DiscussionThreadStatus.CLOSED,
      );
      expect(update).toHaveBeenCalledTimes(1);
    });

    it('hides a comment selected from the comment select menu', async () => {
      const discussionsService = {
        adminHideComment: jest.fn().mockResolvedValue({}),
        getThreadDetail: jest.fn().mockResolvedValue({
          thread: {
            id: 5,
            status: DiscussionThreadStatus.OPEN,
            title: '토론',
            noticeNum: 1,
            commentCount: 1,
          },
          comments: [
            {
              id: 42,
              sequence: 1,
              authorNickname: '익명',
              content: '내용',
              isDeleted: false,
              messageType: DiscussionMessageType.USER,
            },
          ],
          hasMore: false,
          nextCursor: null,
        }),
      };
      const { service } = createService(discussionsService);
      const update = jest.fn().mockResolvedValue(undefined);
      const interaction = {
        isButton: () => false,
        isStringSelectMenu: () => true,
        customId: 'da:selcomment:5:0:1:-',
        values: ['42'],
        update,
      } as any;

      await service.executeComponentInteraction(interaction);

      expect(discussionsService.adminHideComment).toHaveBeenCalledWith(42);
      expect(update).toHaveBeenCalledTimes(1);
    });

    it('moves to the previous comment page on a cprev button', async () => {
      const discussionsService = {
        getThreadDetail: jest.fn().mockResolvedValue({
          thread: {
            id: 5,
            status: DiscussionThreadStatus.OPEN,
            title: '토론',
            noticeNum: 1,
            commentCount: 20,
          },
          comments: [],
          hasMore: true,
          nextCursor: null,
        }),
      };
      const { service } = createService(discussionsService);
      const update = jest.fn().mockResolvedValue(undefined);
      const interaction = {
        isButton: () => true,
        isStringSelectMenu: () => false,
        customId: 'da:cprev:5:2:1:-',
        update,
      } as any;

      await service.executeComponentInteraction(interaction);

      expect(discussionsService.getThreadDetail).toHaveBeenCalledWith(5, 0, 8);
      expect(update).toHaveBeenCalledTimes(1);
    });

    it('moves to the next comment page on a cnext button', async () => {
      const discussionsService = {
        getThreadDetail: jest.fn().mockResolvedValue({
          thread: {
            id: 5,
            status: DiscussionThreadStatus.OPEN,
            title: '토론',
            noticeNum: 1,
            commentCount: 20,
          },
          comments: [],
          hasMore: true,
          nextCursor: null,
        }),
      };
      const { service } = createService(discussionsService);
      const update = jest.fn().mockResolvedValue(undefined);
      const interaction = {
        isButton: () => true,
        isStringSelectMenu: () => false,
        customId: 'da:cnext:5:1:1:-',
        update,
      } as any;

      await service.executeComponentInteraction(interaction);

      expect(discussionsService.getThreadDetail).toHaveBeenCalledWith(5, 8, 8);
      expect(update).toHaveBeenCalledTimes(1);
    });

    it('never goes below the first comment page', async () => {
      const discussionsService = {
        getThreadDetail: jest.fn().mockResolvedValue({
          thread: {
            id: 5,
            status: DiscussionThreadStatus.OPEN,
            title: '토론',
            noticeNum: 1,
            commentCount: 5,
          },
          comments: [],
          hasMore: false,
          nextCursor: null,
        }),
      };
      const { service } = createService(discussionsService);
      const update = jest.fn().mockResolvedValue(undefined);
      const interaction = {
        isButton: () => true,
        isStringSelectMenu: () => false,
        customId: 'da:cprev:5:1:1:-',
        update,
      } as any;

      await service.executeComponentInteraction(interaction);

      expect(discussionsService.getThreadDetail).toHaveBeenCalledWith(5, 0, 8);
    });

    it('locks a thread from the lock/unlock toggle button', async () => {
      const discussionsService = {
        getThreadDetail: jest
          .fn()
          .mockResolvedValueOnce({
            thread: {
              id: 5,
              status: DiscussionThreadStatus.OPEN,
              isLocked: false,
            },
            comments: [],
            hasMore: false,
            nextCursor: null,
          })
          .mockResolvedValueOnce({
            thread: {
              id: 5,
              status: DiscussionThreadStatus.CLOSED,
              isLocked: true,
              title: '토론',
              noticeNum: 1,
              commentCount: 1,
            },
            comments: [],
            hasMore: false,
            nextCursor: null,
          }),
        adminSetThreadLock: jest.fn().mockResolvedValue({}),
      };
      const { service } = createService(discussionsService);
      const update = jest.fn().mockResolvedValue(undefined);
      const interaction = {
        isButton: () => true,
        isStringSelectMenu: () => false,
        customId: 'da:lock:5:1:1:-',
        update,
      } as any;

      await service.executeComponentInteraction(interaction);

      expect(discussionsService.adminSetThreadLock).toHaveBeenCalledWith(
        5,
        true,
      );
      expect(update).toHaveBeenCalledTimes(1);
    });

    it('shows a modal when the post-message button is clicked', async () => {
      const { service } = createService({});
      const showModal = jest.fn().mockResolvedValue(undefined);
      const interaction = {
        isButton: () => true,
        isStringSelectMenu: () => false,
        customId: 'da:postbtn:5:1:1:-',
        showModal,
      } as any;

      const handled = await service.executeComponentInteraction(interaction);

      expect(handled).toBe(true);
      expect(showModal).toHaveBeenCalledTimes(1);
    });

    it('posts an admin message on modal submit and re-renders the detail view', async () => {
      const discussionsService = {
        adminPostMessage: jest.fn().mockResolvedValue({}),
        getThreadDetail: jest.fn().mockResolvedValue({
          thread: {
            id: 5,
            status: DiscussionThreadStatus.OPEN,
            title: '토론',
            noticeNum: 1,
            commentCount: 2,
          },
          comments: [],
          hasMore: false,
          nextCursor: null,
        }),
      };
      const { service } = createService(discussionsService);
      const update = jest.fn().mockResolvedValue(undefined);
      const interaction = {
        isButton: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => true,
        isFromMessage: () => true,
        customId: 'da:postmodal:5:1:1:-',
        fields: {
          getTextInputValue: (field: string) =>
            field === 'content' ? '공지 내용' : '',
        },
        update,
      } as any;

      const handled = await service.executeComponentInteraction(interaction);

      expect(handled).toBe(true);
      expect(discussionsService.adminPostMessage).toHaveBeenCalledWith(
        5,
        '공지 내용',
        undefined,
      );
      expect(update).toHaveBeenCalledTimes(1);
    });
  });
});
