import { CronJobsService } from './cronjobs.service';
import { LoggerUtils } from '../../utils/logger.utils';

describe('CronJobsService', () => {
  beforeEach(() => {
    jest.spyOn(LoggerUtils, 'getContextLogger').mockReturnValue({
      log: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      verbose: jest.fn(),
    } as any);
    jest.spyOn(LoggerUtils, 'debugDev').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should run web push inactive cleanup without system monitoring', async () => {
    const webPushSubscriptionService = {
      cleanupInactiveSubscriptions: jest.fn().mockResolvedValue(2),
    };

    const service = new CronJobsService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { closeIdleThreads: jest.fn().mockResolvedValue(3) } as any,
      webPushSubscriptionService as any,
      undefined as any,
    );

    await service.handleWebPushCleanup();

    expect(
      webPushSubscriptionService.cleanupInactiveSubscriptions,
    ).toHaveBeenCalledWith(14);
  });

  it('records discussion idle-close execution through the cron status wrapper', async () => {
    const discussionsService = {
      closeIdleThreads: jest.fn().mockResolvedValue(3),
    };

    const service = new CronJobsService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      discussionsService as any,
      undefined as any,
      undefined as any,
    );

    await service.handleDiscussionIdleClose();

    expect(discussionsService.closeIdleThreads).toHaveBeenCalledTimes(1);
    expect(service.getCronJobsStatus()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskName: 'discussion idle close',
          status: 'idle',
          lastRunAt: expect.any(String),
          lastError: null,
        }),
      ]),
    );
  });

  it('removes discussion web push bindings for threads closed past the cutoff', async () => {
    const discussionsService = {
      findClosedThreadIdsOlderThan: jest.fn().mockResolvedValue([1, 2]),
    };
    const webPushSubscriptionService = {
      deleteBindingsForThreadIds: jest.fn().mockResolvedValue(5),
    };

    const service = new CronJobsService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      discussionsService as any,
      webPushSubscriptionService as any,
      undefined as any,
    );

    await service.handleDiscussionWebPushCleanup();

    expect(
      discussionsService.findClosedThreadIdsOlderThan,
    ).toHaveBeenCalledWith(7);
    expect(
      webPushSubscriptionService.deleteBindingsForThreadIds,
    ).toHaveBeenCalledWith([1, 2]);
  });

  it('skips deleting bindings when no threads are past the cutoff', async () => {
    const discussionsService = {
      findClosedThreadIdsOlderThan: jest.fn().mockResolvedValue([]),
    };
    const webPushSubscriptionService = {
      deleteBindingsForThreadIds: jest.fn(),
    };

    const service = new CronJobsService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      discussionsService as any,
      webPushSubscriptionService as any,
      undefined as any,
    );

    await service.handleDiscussionWebPushCleanup();

    expect(
      webPushSubscriptionService.deleteBindingsForThreadIds,
    ).not.toHaveBeenCalled();
  });
});
