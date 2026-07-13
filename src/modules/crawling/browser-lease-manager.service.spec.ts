import { BrowserLeaseManagerService } from './browser-lease-manager.service';

describe('BrowserLeaseManagerService', () => {
  let service: BrowserLeaseManagerService;

  beforeEach(() => {
    service = new BrowserLeaseManagerService();
    jest.restoreAllMocks();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('tracks browser descendants created during lease and clears them when closed', async () => {
    const collectSpy = jest
      .spyOn(service as any, 'collectBrowserDescendants')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { pid: 4321, ppid: process.pid, stat: 'S', command: 'chromium' },
      ])
      .mockResolvedValueOnce([]);

    const session = {
      closeBrowser: jest.fn().mockResolvedValue(undefined),
      browser: { process: () => ({ pid: 4321 }) },
    };

    const result = await service.runWithLease(
      'lease-test',
      session,
      async () => {
        return 'ok';
      },
    );

    expect(result).toBe('ok');
    expect(session.closeBrowser).toHaveBeenCalledTimes(1);
    expect(collectSpy).toHaveBeenCalledTimes(3);
    expect((service as any).trackedBrowserPids.size).toBe(0);
  });

  it('forces cleanup when browser process remains alive after close', async () => {
    jest
      .spyOn(service as any, 'collectBrowserDescendants')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { pid: 777, ppid: process.pid, stat: 'S', command: 'chromium' },
      ])
      .mockResolvedValueOnce([
        { pid: 777, ppid: process.pid, stat: 'S', command: 'chromium' },
      ]);

    jest
      .spyOn(service as any, 'isProcessAlive')
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const forceKillSpy = jest
      .spyOn(service as any, 'forceKillProcessTree')
      .mockResolvedValue(undefined);

    const session = {
      closeBrowser: jest.fn().mockResolvedValue(undefined),
      browser: { process: () => ({ pid: 777 }) },
    };

    await service.runWithLease('leak-test', session, async () => undefined);

    expect(forceKillSpy).toHaveBeenCalledWith(777, 'leak-test');
    expect((service as any).trackedBrowserPids.size).toBe(0);
  });

  it('keeps zombie browser pids tracked and does not force kill them during lease close', async () => {
    jest
      .spyOn(service as any, 'collectBrowserDescendants')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { pid: 901, ppid: process.pid, stat: 'S', command: 'chromium' },
      ])
      .mockResolvedValueOnce([
        { pid: 901, ppid: process.pid, stat: 'Z', command: 'chromium' },
      ]);

    const forceKillSpy = jest
      .spyOn(service as any, 'forceKillProcessTree')
      .mockResolvedValue(undefined);

    const session = {
      closeBrowser: jest.fn().mockResolvedValue(undefined),
      browser: { process: () => ({ pid: 901 }) },
    };

    await service.runWithLease('zombie-test', session, async () => undefined);

    expect(forceKillSpy).not.toHaveBeenCalled();
    expect((service as any).trackedBrowserPids.has(901)).toBe(true);
  });

  it('rejects new lease acquisition after shutdown starts', async () => {
    jest.spyOn(service as any, 'waitForIdle').mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'collectBrowserDescendants')
      .mockResolvedValue([]);

    await service.onApplicationShutdown('SIGTERM');

    const session = { closeBrowser: jest.fn().mockResolvedValue(undefined) };

    await expect(
      service.runWithLease('after-shutdown', session, async () => undefined),
    ).rejects.toThrow('browser lease manager is shutting down');
  });

  it('forces cleanup for tracked pids and discovered descendants during shutdown', async () => {
    (service as any).trackedBrowserPids.add(111);

    jest.spyOn(service as any, 'waitForIdle').mockResolvedValue(undefined);

    jest
      .spyOn(service as any, 'collectBrowserDescendants')
      .mockResolvedValue([
        { pid: 222, ppid: process.pid, stat: 'S', command: 'chromium' },
      ]);

    const forceKillSpy = jest
      .spyOn(service as any, 'forceKillProcessTree')
      .mockResolvedValue(undefined);

    await service.onApplicationShutdown('SIGINT');

    expect(forceKillSpy).toHaveBeenCalledWith(111, 'shutdown(SIGINT)');
    expect(forceKillSpy).toHaveBeenCalledWith(222, 'shutdown(SIGINT)');
  });
});
