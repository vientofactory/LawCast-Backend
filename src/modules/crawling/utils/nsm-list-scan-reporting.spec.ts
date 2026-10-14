import { describe, expect, it, jest } from '@jest/globals';
import { BridgeLogLevel } from '../../discord-bridge/discord-bridge.types';
import { reportNsmListScanOutcome } from './nsm-list-scan-reporting';
import {
  NSM_LIST_SCAN_HEALTH_CACHE_KEY,
  type NsmListScanHealth,
  type NsmListScanHealthStore,
} from './nsm-list-scan-health.util';

const BASE_TIME = new Date('2026-10-14T00:00:00.000Z');

const minutesLater = (minutes: number) =>
  new Date(BASE_TIME.getTime() + minutes * 60 * 1000);

const createStore = () => {
  const values = new Map<string, unknown>();

  return {
    getObject: async <T>(key: string): Promise<T | null> =>
      (values.get(key) as T) ?? null,
    setObject: async <T>(key: string, value: T): Promise<boolean> => {
      values.set(key, value);
      return true;
    },
  } as NsmListScanHealthStore;
};

const createDeps = (store?: NsmListScanHealthStore) => {
  const cacheService = store ?? createStore();

  return {
    cacheService,
    logger: {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    discordBridge: { logEvent: jest.fn() },
  };
};

type ReporterDeps = ReturnType<typeof createDeps>;

const report = (
  deps: ReporterDeps,
  params: { itemsObserved: number; minutesOffset: number },
) =>
  reportNsmListScanOutcome({
    deps: deps as never,
    itemsObserved: params.itemsObserved,
    observedAt: minutesLater(params.minutesOffset),
    context: 'CrawlingSchedulerService',
    label: 'NSM pending scan',
    nextStepDescription:
      'nothing was archived and source-missing detection was skipped',
  });

const warnMessages = (deps: ReporterDeps) =>
  (deps.logger.warn as jest.Mock).mock.calls.map(([message]) =>
    String(message),
  );

describe('reportNsmListScanOutcome', () => {
  it('reports a zero-row scan as a failed observation and skips reconciliation', async () => {
    const deps = createDeps();

    const isZeroRowScan = await report(deps, {
      itemsObserved: 0,
      minutesOffset: 0,
    });

    expect(isZeroRowScan).toBe(true);
    expect(warnMessages(deps)).toContainEqual(
      expect.stringContaining('returned 0 notices'),
    );
    expect(warnMessages(deps)).toContainEqual(
      expect.stringContaining('zero-row scan 1/3'),
    );
    expect(deps.logger.error).not.toHaveBeenCalled();
  });

  it('stays quiet for a scan that returned rows', async () => {
    const deps = createDeps();

    const isZeroRowScan = await report(deps, {
      itemsObserved: 15203,
      minutesOffset: 0,
    });

    expect(isZeroRowScan).toBe(false);
    expect(deps.logger.warn).not.toHaveBeenCalled();
    expect(deps.logger.error).not.toHaveBeenCalled();
  });

  it('raises an error-level alert once the zero-row streak reaches the threshold', async () => {
    const deps = createDeps();

    await report(deps, { itemsObserved: 0, minutesOffset: 0 });
    await report(deps, { itemsObserved: 0, minutesOffset: 25 });
    expect(deps.logger.error).not.toHaveBeenCalled();

    await report(deps, { itemsObserved: 0, minutesOffset: 50 });

    const errorMessages = (deps.logger.error as jest.Mock).mock.calls.map(
      ([message]) => String(message),
    );
    expect(errorMessages).toContainEqual(
      expect.stringContaining('collection is degraded'),
    );
    expect(errorMessages).toContainEqual(
      expect.stringContaining(
        '3 consecutive completed scans returned 0 notices',
      ),
    );
    expect(deps.discordBridge.logEvent).toHaveBeenCalledWith(
      BridgeLogLevel.ERROR,
      'CrawlingSchedulerService',
      expect.stringContaining('degraded'),
      expect.objectContaining({ consecutiveZeroRowScans: 3 }),
    );
  });

  it('does not repeat the error alert on every stalled cycle', async () => {
    const deps = createDeps();

    await report(deps, { itemsObserved: 0, minutesOffset: 0 });
    await report(deps, { itemsObserved: 0, minutesOffset: 25 });
    await report(deps, { itemsObserved: 0, minutesOffset: 50 });
    expect(deps.logger.error).toHaveBeenCalledTimes(1);

    // Next cycle (20 minutes later, well inside the 6-hour repeat interval).
    await report(deps, { itemsObserved: 0, minutesOffset: 70 });

    expect(deps.logger.error).toHaveBeenCalledTimes(1);
    expect(warnMessages(deps)).toContainEqual(
      expect.stringContaining('zero-row scan 4/3'),
    );
  });

  it('announces the recovery and resumes reconciliation when rows return', async () => {
    const deps = createDeps();

    await report(deps, { itemsObserved: 0, minutesOffset: 0 });
    await report(deps, { itemsObserved: 0, minutesOffset: 25 });
    await report(deps, { itemsObserved: 0, minutesOffset: 50 });

    const isZeroRowScan = await report(deps, {
      itemsObserved: 15950,
      minutesOffset: 70,
    });

    expect(isZeroRowScan).toBe(false);
    expect(warnMessages(deps)).toContainEqual(
      expect.stringContaining('recovered'),
    );
    expect(warnMessages(deps)).toContainEqual(
      expect.stringContaining('3 consecutive zero-row scan(s)'),
    );
  });

  it('still reports a zero-row scan when the health store is unavailable', async () => {
    const deps = createDeps({
      getObject: jest.fn(async () => {
        throw new Error('redis down');
      }),
      setObject: jest.fn(async () => true),
    } as unknown as NsmListScanHealthStore);

    const isZeroRowScan = await report(deps, {
      itemsObserved: 0,
      minutesOffset: 0,
    });

    expect(isZeroRowScan).toBe(true);
    expect(warnMessages(deps)).toContainEqual(
      expect.stringContaining('failed to record list-scan health'),
    );
    expect(warnMessages(deps)).toContainEqual(
      expect.stringContaining('returned 0 notices'),
    );
  });

  it('does not fail a scan that returned rows when the health store is unavailable', async () => {
    const deps = createDeps({
      getObject: jest.fn(async () => {
        throw new Error('redis down');
      }),
      setObject: jest.fn(async () => true),
    } as unknown as NsmListScanHealthStore);

    const isZeroRowScan = await report(deps, {
      itemsObserved: 42,
      minutesOffset: 0,
    });

    expect(isZeroRowScan).toBe(false);
  });

  it('records the health under the shared cache key so the status API can read it', async () => {
    const values = new Map<string, unknown>();
    const deps = createDeps({
      getObject: async <T>(key: string): Promise<T | null> =>
        (values.get(key) as T) ?? null,
      setObject: async <T>(key: string, value: T): Promise<boolean> => {
        values.set(key, value);
        return true;
      },
    } as NsmListScanHealthStore);

    await report(deps, { itemsObserved: 0, minutesOffset: 0 });

    const stored = values.get(
      NSM_LIST_SCAN_HEALTH_CACHE_KEY,
    ) as NsmListScanHealth;
    expect(stored.consecutiveZeroRowScans).toBe(1);
    expect(stored.lastScanItemCount).toBe(0);
  });
});
