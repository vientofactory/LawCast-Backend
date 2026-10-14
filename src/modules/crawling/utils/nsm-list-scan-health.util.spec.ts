import { describe, expect, it, jest } from '@jest/globals';
import {
  NSM_LIST_SCAN_HEALTH_CACHE_KEY,
  describeNsmListScanHealth,
  readNsmListScanHealth,
  recordNsmListScanResult,
  type NsmListScanHealth,
  type NsmListScanHealthStore,
} from './nsm-list-scan-health.util';

const BASE_TIME = new Date('2026-10-14T00:00:00.000Z');

const minutesLater = (minutes: number) =>
  new Date(BASE_TIME.getTime() + minutes * 60 * 1000);

const createStore = (seed?: NsmListScanHealth) => {
  const values = new Map<string, unknown>();

  if (seed) {
    values.set(NSM_LIST_SCAN_HEALTH_CACHE_KEY, seed);
  }

  const store = {
    getObject: async <T>(key: string): Promise<T | null> =>
      (values.get(key) as T) ?? null,
    setObject: async <T>(key: string, value: T): Promise<boolean> => {
      values.set(key, value);
      return true;
    },
  };

  return store as NsmListScanHealthStore;
};

const record = (
  store: NsmListScanHealthStore,
  params: {
    itemsObserved: number;
    minutesOffset: number;
    degradedThreshold?: number;
    alertRepeatHours?: number;
  },
) =>
  recordNsmListScanResult(store, {
    itemsObserved: params.itemsObserved,
    observedAt: minutesLater(params.minutesOffset),
    degradedThreshold: params.degradedThreshold ?? 3,
    alertRepeatHours: params.alertRepeatHours ?? 6,
  });

describe('NSM list scan health', () => {
  it('records nothing until a scan reports a result', async () => {
    const store = createStore();

    expect(await readNsmListScanHealth(store)).toBeNull();
  });

  it('treats the first zero-row scan as a warning, not yet degraded', async () => {
    const store = createStore();

    const outcome = await record(store, { itemsObserved: 0, minutesOffset: 0 });

    expect(outcome.isZeroRowScan).toBe(true);
    expect(outcome.justDegraded).toBe(false);
    expect(outcome.health.consecutiveZeroRowScans).toBe(1);
    expect(outcome.health.degraded).toBe(false);
    expect(outcome.health.lastSuccessfulScanAt).toBeNull();
  });

  it('escalates once the zero-row streak reaches the threshold', async () => {
    const store = createStore();

    const first = await record(store, { itemsObserved: 0, minutesOffset: 0 });
    const second = await record(store, { itemsObserved: 0, minutesOffset: 25 });
    const third = await record(store, { itemsObserved: 0, minutesOffset: 50 });

    expect(first.justDegraded).toBe(false);
    expect(second.justDegraded).toBe(false);
    expect(third.justDegraded).toBe(true);
    expect(third.health.degraded).toBe(true);
    expect(third.health.consecutiveZeroRowScans).toBe(3);
    expect(third.health.degradedSince).toBe(minutesLater(50).toISOString());
    expect(third.health.lastAlertAt).toBe(minutesLater(50).toISOString());
  });

  it('counts the cron and archive-sync scans of one cycle as a single zero-row cycle', async () => {
    const store = createStore();

    // Two scan paths run within minutes of each other in the same cycle.
    await record(store, { itemsObserved: 0, minutesOffset: 0 });
    const sameCycle = await record(store, {
      itemsObserved: 0,
      minutesOffset: 2,
    });

    expect(sameCycle.health.consecutiveZeroRowScans).toBe(1);

    // The next cycle is a new observation.
    const nextCycle = await record(store, {
      itemsObserved: 0,
      minutesOffset: 20,
    });
    expect(nextCycle.health.consecutiveZeroRowScans).toBe(2);
  });

  it('refreshes the last scan bookkeeping without extending the streak on a same-cycle scan', async () => {
    const store = createStore();

    await record(store, { itemsObserved: 4, minutesOffset: 0 });
    const sameCycleZero = await record(store, {
      itemsObserved: 0,
      minutesOffset: 3,
    });

    // A zero-row scan in the same cycle still reports the failure, but the
    // streak restarts from this cycle rather than assuming two stalled cycles.
    expect(sameCycleZero.isZeroRowScan).toBe(true);
    expect(sameCycleZero.health.consecutiveZeroRowScans).toBe(1);
    expect(sameCycleZero.health.lastScanItemCount).toBe(0);
    expect(sameCycleZero.health.lastSuccessfulScanItemCount).toBe(4);
  });

  it('rate-limits repeat alerts while the collector stays degraded', async () => {
    const store = createStore();

    await record(store, {
      itemsObserved: 0,
      minutesOffset: 0,
      degradedThreshold: 1,
      alertRepeatHours: 6,
    });

    const soon = await record(store, {
      itemsObserved: 0,
      minutesOffset: 60,
      degradedThreshold: 1,
      alertRepeatHours: 6,
    });
    expect(soon.shouldRepeatAlert).toBe(false);

    const later = await record(store, {
      itemsObserved: 0,
      minutesOffset: 7 * 60,
      degradedThreshold: 1,
      alertRepeatHours: 6,
    });
    expect(later.shouldRepeatAlert).toBe(true);
    expect(later.justDegraded).toBe(false);
    expect(later.health.lastAlertAt).toBe(minutesLater(7 * 60).toISOString());
  });

  it('clears the streak and reports the recovery when rows come back', async () => {
    const store = createStore();

    await record(store, { itemsObserved: 0, minutesOffset: 0 });
    await record(store, { itemsObserved: 0, minutesOffset: 25 });
    await record(store, { itemsObserved: 0, minutesOffset: 50 });

    const recovered = await record(store, {
      itemsObserved: 12345,
      minutesOffset: 70,
    });

    expect(recovered.isZeroRowScan).toBe(false);
    expect(recovered.recoveredFromZeroRowScans).toBe(3);
    expect(recovered.health.degraded).toBe(false);
    expect(recovered.health.degradedSince).toBeNull();
    expect(recovered.health.consecutiveZeroRowScans).toBe(0);
    expect(recovered.health.lastSuccessfulScanAt).toBe(
      minutesLater(70).toISOString(),
    );
    expect(recovered.health.lastSuccessfulScanItemCount).toBe(12345);
  });

  it('does not report a recovery when the previous scan was already healthy', async () => {
    const store = createStore();

    await record(store, { itemsObserved: 10, minutesOffset: 0 });
    const second = await record(store, {
      itemsObserved: 20,
      minutesOffset: 25,
    });

    expect(second.recoveredFromZeroRowScans).toBe(0);
  });

  it('persists the record under the shared cache key for the status API', async () => {
    const store = createStore();

    await record(store, { itemsObserved: 0, minutesOffset: 0 });

    const stored = await readNsmListScanHealth(store);
    expect(stored).not.toBeNull();
    expect(stored?.lastScanAt).toBe(BASE_TIME.toISOString());
  });

  it('reports staleness from the last scan that actually returned rows', async () => {
    const health: NsmListScanHealth = {
      source: 'nsm',
      lastScanAt: minutesLater(60).toISOString(),
      lastScanItemCount: 0,
      lastSuccessfulScanAt: BASE_TIME.toISOString(),
      lastSuccessfulScanItemCount: 9000,
      consecutiveZeroRowScans: 3,
      degraded: true,
      degradedSince: minutesLater(50).toISOString(),
      lastAlertAt: minutesLater(50).toISOString(),
    };

    const description = describeNsmListScanHealth(health, minutesLater(180));

    expect(description.staleHours).toBe(3);
    expect(description.lastSuccessfulScanAgoLabel).toContain('3 hour(s)');
  });

  it('reports an unknown staleness instead of a fake healthy value', async () => {
    expect(describeNsmListScanHealth(null)).toEqual({
      staleHours: null,
      lastSuccessfulScanAgoLabel: null,
    });

    expect(
      describeNsmListScanHealth({
        source: 'nsm',
        lastScanAt: BASE_TIME.toISOString(),
        lastScanItemCount: 0,
        lastSuccessfulScanAt: null,
        lastSuccessfulScanItemCount: 0,
        consecutiveZeroRowScans: 1,
        degraded: false,
        degradedSince: null,
        lastAlertAt: null,
      }),
    ).toEqual({
      staleHours: null,
      lastSuccessfulScanAgoLabel: 'no successful list scan recorded yet',
    });
  });
});

describe('NSM list scan health store failures', () => {
  it('treats an unreadable record as a first scan instead of throwing', async () => {
    const store = {
      getObject: jest.fn(async () => null),
      setObject: jest.fn(async () => true),
    } as unknown as NsmListScanHealthStore;

    const outcome = await record(store, {
      itemsObserved: 0,
      minutesOffset: 0,
    });

    expect(outcome.health.consecutiveZeroRowScans).toBe(1);
    expect(store.setObject).toHaveBeenCalled();
  });
});
