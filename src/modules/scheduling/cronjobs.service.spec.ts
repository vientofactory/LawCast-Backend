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
    }) => {
      const crawlingService = {
        handleProposalReasonBackfillCron: jest
          .fn()
          .mockResolvedValue(undefined),
        // The tick must never gate the drain on the crawl scheduler again: the
        // drain waits for the browser itself, and re-introducing this check is
        // what starved the backlog on 15 consecutive production ticks.
        isSchedulerBusy: jest.fn(() => {
          throw new Error(
            'the proposalReason tick must not consult the crawl scheduler',
          );
        }),
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

    it('hands the tick to the NSM drain without consulting the crawl scheduler', async () => {
      const { service, crawlingService, archiveSyncService } = buildService({
        writeHeavyRunning: false,
      });

      await service.handleProposalReasonBackfillDrain();

      // A busy crawl scheduler is no longer a tick-level skip: the drain owns
      // the browser-window wait (and a visible deferral) itself, so the cron
      // must still hand it the tick. Skipping here is what starved the backlog
      // on 15 consecutive ticks while this half ran on all of them.
      expect(
        crawlingService.handleProposalReasonBackfillCron,
      ).toHaveBeenCalledTimes(1);
      expect(archiveSyncService.runSummaryBackfill).toHaveBeenCalledWith(
        'proposal-reason-cron',
      );
      expect(taskStatus(service)?.lastRunAt).toEqual(expect.any(String));
    });

    it('defers the NSM drain on archive-sync write-heavy activity, and logs it at production level', async () => {
      const { service, crawlingService } = buildService({
        writeHeavyRunning: true,
        runningWriteHeavyActivities: ['integrity check'],
      });

      await service.handleProposalReasonBackfillDrain();

      expect(
        crawlingService.handleProposalReasonBackfillCron,
      ).not.toHaveBeenCalled();
      // A tick that does no work must be visible: the silent version of this
      // skip hid a frozen backlog for hours.
      expect(loggerMock.log).toHaveBeenCalledWith(
        'proposalReason NSM reason drain skipped - archive sync write-heavy phase is currently running (runningWriteHeavyPhases=integrity check)',
      );
    });

    it('defers both halves of the tick while archive sync is write-heavy, and says so', async () => {
      const { service, crawlingService, archiveSyncService } = buildService({
        writeHeavyRunning: true,
        runningWriteHeavyActivities: ['isDone sync'],
      });

      await service.handleProposalReasonBackfillDrain();

      expect(
        crawlingService.handleProposalReasonBackfillCron,
      ).not.toHaveBeenCalled();
      expect(archiveSyncService.runSummaryBackfill).not.toHaveBeenCalled();
      // Both halves name themselves, so a deferred tick is attributable.
      expect(loggerMock.log).toHaveBeenCalledWith(
        'proposalReason NSM reason drain skipped - archive sync write-heavy phase is currently running (runningWriteHeavyPhases=isDone sync)',
      );
      expect(loggerMock.log).toHaveBeenCalledWith(
        'summary backfill (proposalReason cron) skipped - archive sync write-heavy activity is currently running (runningWriteHeavyActivities=isDone sync)',
      );
      // A deferred tick still fired, so the schedule stays observable.
      expect(taskStatus(service)?.lastRunAt).toEqual(expect.any(String));
    });

    it('runs both parts of the tick when archive sync is idle', async () => {
      const { service, crawlingService, archiveSyncService } = buildService({
        writeHeavyRunning: false,
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

    it('finishes the summary half before the drain can hold the tick in browser work', async () => {
      const { service, crawlingService, archiveSyncService } = buildService({
        writeHeavyRunning: false,
      });
      // The drain can wait minutes for a browser and then run a full batch; the
      // summary pass has no browser to wait for, so it must not queue behind it.
      (archiveSyncService.runSummaryBackfill as jest.Mock).mockImplementation(
        async () => null,
      );

      await service.handleProposalReasonBackfillDrain();

      const summaryOrder = (archiveSyncService.runSummaryBackfill as jest.Mock)
        .mock.invocationCallOrder[0];
      const drainOrder = (
        crawlingService.handleProposalReasonBackfillCron as jest.Mock
      ).mock.invocationCallOrder[0];

      expect(summaryOrder).toBeLessThan(drainOrder);
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
