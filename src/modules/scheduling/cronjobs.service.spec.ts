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
      webPushSubscriptionService as any,
      undefined as any,
    );

    await service.handleSystemMonitoring();

    expect(webhookCleanupService.runSystemMonitoring).toHaveBeenCalledTimes(1);
    expect(
      webPushSubscriptionService.cleanupInactiveSubscriptions,
    ).toHaveBeenCalledWith(14);
  });
});
