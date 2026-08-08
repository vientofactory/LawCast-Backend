import {
  ArchiveOrchestratorScreenshotCoordinator,
  type ScreenshotQueueItem,
} from './archive-orchestrator-screenshot-coordinator';

describe('ArchiveOrchestratorScreenshotCoordinator', () => {
  it('drains screenshot queue in bounded parallel batches', async () => {
    const queueState: ScreenshotQueueItem[] = [
      {
        num: 1,
        contentId: 'content-1',
        isDone: false,
        retryCount: 0,
      },
      {
        num: 2,
        contentId: '',
        isDone: false,
        nsmBillNo: '2200002',
        retryCount: 0,
      },
      {
        num: 3,
        contentId: 'content-3',
        isDone: true,
        retryCount: 0,
      },
    ];

    const updateScreenshot = jest.fn().mockResolvedValue(undefined);

    let resolveFirst: ((value: Buffer) => void) | undefined;
    let resolveNsm: ((value: Buffer) => void) | undefined;
    let resolveSecond: ((value: Buffer) => void) | undefined;

    const firstPromise = new Promise<Buffer>((resolve) => {
      resolveFirst = resolve;
    });
    const nsmPromise = new Promise<Buffer>((resolve) => {
      resolveNsm = resolve;
    });
    const secondPromise = new Promise<Buffer>((resolve) => {
      resolveSecond = resolve;
    });

    const cacheService = {
      getObject: jest.fn(async () => queueState),
      setObject: jest.fn(async (_key: string, value: ScreenshotQueueItem[]) => {
        queueState.splice(0, queueState.length, ...value);
        return true;
      }),
      deleteKey: jest.fn(async () => {
        queueState.splice(0, queueState.length);
        return true;
      }),
    };

    const captureContentScreenshot = jest
      .fn()
      .mockImplementationOnce(() => firstPromise)
      .mockImplementationOnce(() => secondPromise);
    const captureNsmDetailScreenshot = jest
      .fn()
      .mockImplementationOnce(() => nsmPromise);

    const coordinator = new ArchiveOrchestratorScreenshotCoordinator({
      cacheService: cacheService as any,
      noticeArchiveService: {
        updateScreenshot,
      } as any,
      crawlingCoreService: {
        captureContentScreenshot,
        captureNsmDetailScreenshot,
      } as any,
      logger: {
        log: jest.fn(),
        warn: jest.fn(),
      },
    });

    const drainPromise = (coordinator as any).drainScreenshotQueue();

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((coordinator as any).isCaptureRunning).toBe(true);
    expect(updateScreenshot).not.toHaveBeenCalled();
    expect(captureContentScreenshot).toHaveBeenCalledTimes(2);
    expect(captureNsmDetailScreenshot).toHaveBeenCalledTimes(1);

    resolveFirst?.(Buffer.from('one'));
    resolveNsm?.(Buffer.from('nsm'));
    resolveSecond?.(Buffer.from('two'));

    await drainPromise;

    expect(updateScreenshot).toHaveBeenCalledTimes(3);
    expect(queueState).toHaveLength(0);
  });
});
