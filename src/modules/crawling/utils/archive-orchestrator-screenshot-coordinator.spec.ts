import {
  ArchiveOrchestratorScreenshotCoordinator,
  type ScreenshotQueueItem,
} from './archive-orchestrator-screenshot-coordinator';

jest.mock('../../../utils/async-delay.utils', () => ({
  delayMs: jest.fn().mockResolvedValue(undefined),
}));

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

  it('records screenshot capture failure when capture returns null (size limit)', async () => {
    const queueState: ScreenshotQueueItem[] = [
      { num: 10, contentId: 'content-10', isDone: false, retryCount: 0 },
    ];
    const updateScreenshot = jest.fn().mockResolvedValue(undefined);
    const recordScreenshotCaptureFailure = jest
      .fn()
      .mockResolvedValue(undefined);

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

    const captureContentScreenshot = jest.fn().mockResolvedValue(null);

    const coordinator = new ArchiveOrchestratorScreenshotCoordinator({
      cacheService: cacheService as any,
      noticeArchiveService: {
        updateScreenshot,
        recordScreenshotCaptureFailure,
      } as any,
      crawlingCoreService: {
        captureContentScreenshot,
        captureNsmDetailScreenshot: jest.fn(),
      } as any,
      logger: { log: jest.fn(), warn: jest.fn() },
    });

    await (coordinator as any).drainScreenshotQueue();

    expect(captureContentScreenshot).toHaveBeenCalledWith('content-10', false);
    expect(updateScreenshot).not.toHaveBeenCalled();
    expect(recordScreenshotCaptureFailure).toHaveBeenCalledWith(
      10,
      expect.stringContaining('size_limit'),
    );
  });

  it('records screenshot capture failure after max retries exceeded', async () => {
    const queueState: ScreenshotQueueItem[] = [
      { num: 20, contentId: 'content-20', isDone: false, retryCount: 3 },
    ];
    const updateScreenshot = jest.fn().mockResolvedValue(undefined);
    const recordScreenshotCaptureFailure = jest
      .fn()
      .mockResolvedValue(undefined);

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
      .mockRejectedValue(new Error('net::ERR_TIMED_OUT'));

    const coordinator = new ArchiveOrchestratorScreenshotCoordinator({
      cacheService: cacheService as any,
      noticeArchiveService: {
        updateScreenshot,
        recordScreenshotCaptureFailure,
      } as any,
      crawlingCoreService: {
        captureContentScreenshot,
        captureNsmDetailScreenshot: jest.fn(),
      } as any,
      logger: { log: jest.fn(), warn: jest.fn() },
    });

    await (coordinator as any).drainScreenshotQueue();

    expect(updateScreenshot).not.toHaveBeenCalled();
    expect(recordScreenshotCaptureFailure).toHaveBeenCalledWith(
      20,
      expect.stringContaining('net::ERR_TIMED_OUT'),
    );
  });

  it('re-queues item when retry count is below max', async () => {
    const queueState: ScreenshotQueueItem[] = [
      { num: 30, contentId: 'content-30', isDone: false, retryCount: 0 },
    ];
    const updateScreenshot = jest.fn().mockResolvedValue(undefined);
    const recordScreenshotCaptureFailure = jest
      .fn()
      .mockResolvedValue(undefined);
    const allSetStates: ScreenshotQueueItem[][] = [];

    const cacheService = {
      getObject: jest.fn(async () => queueState),
      setObject: jest.fn(async (_key: string, value: ScreenshotQueueItem[]) => {
        allSetStates.push([...value]);
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
      .mockRejectedValue(new Error('temporary failure'));

    const coordinator = new ArchiveOrchestratorScreenshotCoordinator({
      cacheService: cacheService as any,
      noticeArchiveService: {
        updateScreenshot,
        recordScreenshotCaptureFailure,
      } as any,
      crawlingCoreService: {
        captureContentScreenshot,
        captureNsmDetailScreenshot: jest.fn(),
      } as any,
      logger: { log: jest.fn(), warn: jest.fn() },
    });

    await (coordinator as any).drainScreenshotQueue();

    expect(updateScreenshot).not.toHaveBeenCalled();
    const requeueWrites = allSetStates.filter(
      (s) => s.length > 0 && s[0].num === 30 && s[0].retryCount > 0,
    );
    expect(requeueWrites.length).toBeGreaterThanOrEqual(1);
    expect(requeueWrites[0][0]).toMatchObject({
      num: 30,
      retryCount: 1,
    });
  });

  it('records screenshot capture failure when NSM capture throws (not null return)', async () => {
    const queueState: ScreenshotQueueItem[] = [
      {
        num: 40,
        contentId: '',
        isDone: false,
        retryCount: 3,
        nsmBillNo: '2200040',
      },
    ];
    const updateScreenshot = jest.fn().mockResolvedValue(undefined);
    const recordScreenshotCaptureFailure = jest
      .fn()
      .mockResolvedValue(undefined);

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

    const captureNsmDetailScreenshot = jest
      .fn()
      .mockRejectedValue(new Error('NSM Waitingroom timeout'));

    const coordinator = new ArchiveOrchestratorScreenshotCoordinator({
      cacheService: cacheService as any,
      noticeArchiveService: {
        updateScreenshot,
        recordScreenshotCaptureFailure,
      } as any,
      crawlingCoreService: {
        captureContentScreenshot: jest.fn(),
        captureNsmDetailScreenshot,
      } as any,
      logger: { log: jest.fn(), warn: jest.fn() },
    });

    await (coordinator as any).drainScreenshotQueue();

    expect(captureNsmDetailScreenshot).toHaveBeenCalledWith('2200040');
    expect(updateScreenshot).not.toHaveBeenCalled();
    expect(recordScreenshotCaptureFailure).toHaveBeenCalledWith(
      40,
      '국회 웹사이트 접근 제한으로 스크린샷을 캡처하지 못했습니다 (rate_limited: NSM Waitingroom timeout)',
    );
  });

  it('re-queues NSM item on first failure then succeeds on retry', async () => {
    const queueState: ScreenshotQueueItem[] = [
      {
        num: 50,
        contentId: '',
        isDone: false,
        retryCount: 0,
        nsmBillNo: '2200050',
      },
    ];
    const updateScreenshot = jest.fn().mockResolvedValue(undefined);
    const recordScreenshotCaptureFailure = jest
      .fn()
      .mockResolvedValue(undefined);

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

    // First attempt throws (re-queued), second attempt succeeds
    const captureNsmDetailScreenshot = jest
      .fn()
      .mockRejectedValueOnce(new Error('temporary NSM error'))
      .mockResolvedValueOnce(Buffer.from('nsm-retry'));

    const coordinator = new ArchiveOrchestratorScreenshotCoordinator({
      cacheService: cacheService as any,
      noticeArchiveService: {
        updateScreenshot,
        recordScreenshotCaptureFailure,
      } as any,
      crawlingCoreService: {
        captureContentScreenshot: jest.fn(),
        captureNsmDetailScreenshot,
      } as any,
      logger: { log: jest.fn(), warn: jest.fn() },
    });

    await (coordinator as any).drainScreenshotQueue();

    // Capture was attempted twice: first failed, second succeeded
    expect(captureNsmDetailScreenshot).toHaveBeenCalledTimes(2);
    expect(captureNsmDetailScreenshot).toHaveBeenCalledWith('2200050');
    // Screenshot saved on second (successful) attempt
    expect(updateScreenshot).toHaveBeenCalledWith(
      50,
      Buffer.from('nsm-retry'),
      'jpeg',
    );
    // Failure NOT permanently recorded — retry succeeded
    expect(recordScreenshotCaptureFailure).not.toHaveBeenCalled();
  });

  it('records failure for NSM item when null screenshot returned (size limit)', async () => {
    const queueState: ScreenshotQueueItem[] = [
      {
        num: 60,
        contentId: '',
        isDone: false,
        retryCount: 0,
        nsmBillNo: '2200060',
      },
    ];
    const updateScreenshot = jest.fn().mockResolvedValue(undefined);
    const recordScreenshotCaptureFailure = jest
      .fn()
      .mockResolvedValue(undefined);

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

    const captureNsmDetailScreenshot = jest.fn().mockResolvedValue(null);

    const coordinator = new ArchiveOrchestratorScreenshotCoordinator({
      cacheService: cacheService as any,
      noticeArchiveService: {
        updateScreenshot,
        recordScreenshotCaptureFailure,
      } as any,
      crawlingCoreService: {
        captureContentScreenshot: jest.fn(),
        captureNsmDetailScreenshot,
      } as any,
      logger: { log: jest.fn(), warn: jest.fn() },
    });

    await (coordinator as any).drainScreenshotQueue();

    expect(captureNsmDetailScreenshot).toHaveBeenCalledWith('2200060');
    expect(updateScreenshot).not.toHaveBeenCalled();
    expect(recordScreenshotCaptureFailure).toHaveBeenCalledWith(
      60,
      '페이지 내용이 너무 커서 스크린샷을 저장할 수 없습니다 (size_limit)',
    );
  });
});
