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

  it('should run web push inactive cleanup during system monitoring', async () => {
    const webhookCleanupService = {
      runSystemMonitoring: jest.fn().mockResolvedValue(undefined),
    };

    const webPushSubscriptionService = {
      cleanupInactiveSubscriptions: jest.fn().mockResolvedValue(2),
    };

    const service = new CronJobsService(
      {} as any,
      webhookCleanupService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { closeIdleThreads: jest.fn().mockResolvedValue(3) } as any,
      webPushSubscriptionService as any,
      undefined as any,
    );

    await service.handleSystemMonitoring();

    expect(webhookCleanupService.runSystemMonitoring).toHaveBeenCalledTimes(1);
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
});
