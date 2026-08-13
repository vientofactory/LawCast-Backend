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

  it('does not track zombie browser pids and does not force kill them during lease close', async () => {
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
    expect((service as any).trackedBrowserPids.has(901)).toBe(false);
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

  describe('lease isolation', () => {
    it('never force kills a chromium owned by a concurrently running lease', async () => {
      const leaseA = {
        closeBrowser: jest.fn().mockResolvedValue(undefined),
        browser: { process: () => ({ pid: 1001 }) },
      };
      const leaseB = {
        closeBrowser: jest.fn().mockResolvedValue(undefined),
        browser: { process: () => ({ pid: 2002 }) },
      };

      const rowA = {
        pid: 1001,
        ppid: process.pid,
        stat: 'S',
        command: 'chromium',
      };
      const rowB = {
        pid: 2002,
        ppid: process.pid,
        stat: 'S',
        command: 'chromium',
      };

      jest
        .spyOn(service as any, 'collectBrowserDescendants')
        // lease A start snapshot
        .mockResolvedValueOnce([])
        // lease B start snapshot (A already running)
        .mockResolvedValueOnce([rowA])
        // lease A close: before/after (B is alive the whole time)
        .mockResolvedValueOnce([rowA, rowB])
        .mockResolvedValueOnce([rowB])
        // lease B close: before/after
        .mockResolvedValueOnce([rowB])
        .mockResolvedValueOnce([]);

      const forceKillSpy = jest
        .spyOn(service as any, 'forceKillProcessTree')
        .mockResolvedValue(undefined);
      jest.spyOn(service as any, 'isProcessAlive').mockResolvedValue(true);

      let releaseA!: () => void;
      const aRunning = new Promise<void>((resolve) => {
        releaseA = resolve;
      });

      const runA = service.runWithLease('leaseA', leaseA, async () => {
        await aRunning;
      });

      const runB = service.runWithLease('leaseB', leaseB, async () => {
        releaseA();
        await runA;
      });

      await Promise.all([runA, runB]);

      expect(forceKillSpy).not.toHaveBeenCalledWith(2002, 'leaseA');
      expect((service as any).trackedBrowserPids.size).toBe(0);
    });

    it('takes the lease start snapshot only after acquiring a slot', async () => {
      (service as any).maxConcurrentLeases = 1;

      const collectSpy = jest
        .spyOn(service as any, 'collectBrowserDescendants')
        .mockResolvedValue([]);

      const order: string[] = [];
      const originalWait = (service as any).waitForLeaseSlot.bind(service);
      jest
        .spyOn(service as any, 'waitForLeaseSlot')
        .mockImplementation(async (label: unknown) => {
          order.push(`wait:${String(label)}`);
          await originalWait(label);
        });

      collectSpy.mockImplementation(async () => {
        order.push('snapshot');
        return [];
      });

      const session = { closeBrowser: jest.fn().mockResolvedValue(undefined) };

      await service.runWithLease('ordered', session, async () => undefined);

      expect(order[0]).toBe('wait:ordered');
      expect(order[1]).toBe('snapshot');
    });

    it('adopts unowned strays only when it is the sole active lease', async () => {
      const stray = {
        pid: 5005,
        ppid: process.pid,
        stat: 'S',
        command: 'chromium',
      };

      jest
        .spyOn(service as any, 'collectBrowserDescendants')
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([stray])
        .mockResolvedValueOnce([stray]);

      jest
        .spyOn(service as any, 'isProcessAlive')
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      const forceKillSpy = jest
        .spyOn(service as any, 'forceKillProcessTree')
        .mockResolvedValue(undefined);

      // No resolvable browser pid on the session.
      const session = { closeBrowser: jest.fn().mockResolvedValue(undefined) };

      await service.runWithLease('sole-lease', session, async () => undefined);

      expect(forceKillSpy).toHaveBeenCalledWith(5005, 'sole-lease');
    });

    it('does not adopt strays when another lease is active and the pid is unresolvable', async () => {
      const stray = {
        pid: 6006,
        ppid: process.pid,
        stat: 'S',
        command: 'chromium',
      };

      jest
        .spyOn(service as any, 'collectBrowserDescendants')
        .mockResolvedValue([stray]);
      jest.spyOn(service as any, 'isProcessAlive').mockResolvedValue(true);

      const forceKillSpy = jest
        .spyOn(service as any, 'forceKillProcessTree')
        .mockResolvedValue(undefined);

      // Simulate a second lease that is still running.
      (service as any).activeLeasePids.set(999, new Set<number>([6006]));

      const session = { closeBrowser: jest.fn().mockResolvedValue(undefined) };

      await service.runWithLease('shared', session, async () => undefined);

      expect(forceKillSpy).not.toHaveBeenCalled();

      (service as any).activeLeasePids.delete(999);
    });

    it('owns the full process tree of its own session', async () => {
      const main = {
        pid: 3003,
        ppid: process.pid,
        stat: 'S',
        command: 'chromium',
      };
      const child = { pid: 3004, ppid: 3003, stat: 'S', command: 'crashpad' };

      jest
        .spyOn(service as any, 'collectBrowserDescendants')
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([main, child])
        .mockResolvedValueOnce([main, child]);

      jest.spyOn(service as any, 'isProcessAlive').mockResolvedValue(false);

      const forceKillSpy = jest
        .spyOn(service as any, 'forceKillProcessTree')
        .mockResolvedValue(undefined);

      const session = {
        closeBrowser: jest.fn().mockResolvedValue(undefined),
        browser: { process: () => ({ pid: 3003 }) },
      };

      await service.runWithLease('tree-test', session, async () => undefined);

      // Both pids were owned; neither is alive so no kill is needed.
      expect(forceKillSpy).not.toHaveBeenCalled();
      expect((service as any).trackedBrowserPids.size).toBe(0);
    });

    it('releases the lease slot and registration even when the task throws', async () => {
      jest
        .spyOn(service as any, 'collectBrowserDescendants')
        .mockResolvedValue([]);

      const session = { closeBrowser: jest.fn().mockResolvedValue(undefined) };

      await expect(
        service.runWithLease('boom', session, async () => {
          throw new Error('task failed');
        }),
      ).rejects.toThrow('task failed');

      expect((service as any).activeLeases).toBe(0);
      expect((service as any).activeLeasePids.size).toBe(0);
      expect(session.closeBrowser).toHaveBeenCalledTimes(1);
    });

    it('releases the lease slot even when close cleanup throws', async () => {
      jest
        .spyOn(service as any, 'collectBrowserDescendants')
        .mockRejectedValueOnce(new Error('ps failed'));

      const session = { closeBrowser: jest.fn().mockResolvedValue(undefined) };

      await expect(
        service.runWithLease('cleanup-boom', session, async () => 'ok'),
      ).rejects.toThrow('ps failed');

      expect((service as any).activeLeases).toBe(0);
      expect((service as any).activeLeasePids.size).toBe(0);
    });
  });
});
