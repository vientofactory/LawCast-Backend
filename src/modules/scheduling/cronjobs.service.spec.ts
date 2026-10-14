import { CronJobsService } from './cronjobs.service';
import { LoggerUtils } from '../../utils/logger.utils';

describe('CronJobsService', () => {
  let loggerMock: {
    log: jest.Mock;
    error: jest.Mock;
    warn: jest.Mock;
    debug: jest.Mock;
    verbose: jest.Mock;
  };

  beforeEach(() => {
    loggerMock = {
      log: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      verbose: jest.fn(),
    };
    jest
      .spyOn(LoggerUtils, 'getContextLogger')
      .mockReturnValue(loggerMock as any);
    jest.spyOn(LoggerUtils, 'debugDev').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('proposalReason backfill drain handler', () => {
    const buildService = (options: {
      writeHeavyRunning: boolean;
      runningWriteHeavyActivities?: string[];
      schedulerBusy: boolean;
    }) => {
      const crawlingService = {
        handleProposalReasonBackfillCron: jest
          .fn()
          .mockResolvedValue(undefined),
        isSchedulerBusy: jest.fn().mockReturnValue(options.schedulerBusy),
      };
      const archiveSyncService = {
        getExecutionState: jest.fn().mockReturnValue({
          isWriteHeavyPhaseRunning: options.writeHeavyRunning,
          runningWriteHeavyPhases: options.runningWriteHeavyActivities ?? [],
        }),
        runSummaryBackfill: jest.fn().mockResolvedValue(null),
      };

      const service = new CronJobsService(
        {} as any,
        {} as any,
        crawlingService as any,
        archiveSyncService as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        undefined as any,
      );

      return { service, crawlingService, archiveSyncService };
    };

    const taskStatus = (service: CronJobsService) =>
      service
        .getCronJobsStatus()
        .find((job) => job.taskName === 'proposalReason backfill drain');

    it('runs the summary backfill while the crawl scheduler is busy', async () => {
      const { service, crawlingService, archiveSyncService } = buildService({
        writeHeavyRunning: false,
        schedulerBusy: true,
      });

      await service.handleProposalReasonBackfillDrain();

      // The browser-heavy NSM drain still yields to crawl workload...
      expect(
        crawlingService.handleProposalReasonBackfillCron,
      ).not.toHaveBeenCalled();
      // ...but the summary backfill must not inherit that skip.
      expect(archiveSyncService.runSummaryBackfill).toHaveBeenCalledWith(
        'proposal-reason-cron',
      );
      expect(taskStatus(service)?.lastRunAt).toEqual(expect.any(String));
    });

    it('defers the summary backfill while archive sync is write-heavy, and logs it at production level', async () => {
      const { service, crawlingService, archiveSyncService } = buildService({
        writeHeavyRunning: true,
        runningWriteHeavyActivities: ['isDone sync'],
        schedulerBusy: false,
      });

      await service.handleProposalReasonBackfillDrain();

      expect(archiveSyncService.runSummaryBackfill).not.toHaveBeenCalled();
      expect(
        crawlingService.handleProposalReasonBackfillCron,
      ).not.toHaveBeenCalled();
      expect(loggerMock.log).toHaveBeenCalledWith(
        'summary backfill (proposalReason cron) skipped - archive sync write-heavy activity is currently running (runningWriteHeavyActivities=isDone sync)',
      );
      // A deferred tick still fired, so the schedule stays observable.
      expect(taskStatus(service)?.lastRunAt).toEqual(expect.any(String));
    });

    it('runs both parts of the tick when archive sync and the crawl scheduler are idle', async () => {
      const { service, crawlingService, archiveSyncService } = buildService({
        writeHeavyRunning: false,
        schedulerBusy: false,
      });

      await service.handleProposalReasonBackfillDrain();

      expect(
        crawlingService.handleProposalReasonBackfillCron,
      ).toHaveBeenCalledTimes(1);
      expect(archiveSyncService.runSummaryBackfill).toHaveBeenCalledWith(
        'proposal-reason-cron',
      );
      expect(loggerMock.log).not.toHaveBeenCalled();
    });
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
