import cronstrue from 'cronstrue/i18n';
import { APP_CONSTANTS } from '../../config/app.config';
import { describeCron, getCronSchedule } from './cron-display.util';

describe('cron description memoization', () => {
  afterEach(() => jest.restoreAllMocks());
  it('formats one immutable expression once and returns the same text', () => {
    const spy = jest.spyOn(cronstrue, 'toString');
    const first = describeCron('3 7 * * *');
    expect(describeCron('3 7 * * *')).toBe(first);
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it('uses a changed expression immediately rather than caching runtime schedule state', () => {
    expect(describeCron('4 8 * * *')).not.toBe(describeCron('5 9 * * *'));
  });
  it('preserves and memoizes the existing fallback for invalid expressions', () => {
    const spy = jest.spyOn(cronstrue, 'toString');
    expect(describeCron('invalid-cron-test')).toBe('invalid-cron-test');
    expect(describeCron('invalid-cron-test')).toBe('invalid-cron-test');
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it('evicts old entries instead of retaining unbounded schedule strings', () => {
    describeCron('eviction-test');
    for (let n = 0; n < 65; n++) describeCron(`invalid-${n}`);
    const spy = jest.spyOn(cronstrue, 'toString');
    describeCron('eviction-test');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('cron schedule presentation', () => {
  it('preserves known intervals and uses the shared description', () => {
    const expression = APP_CONSTANTS.CRON.EXPRESSIONS.CRAWLING_CHECK;
    expect(getCronSchedule(expression)).toEqual({
      expression,
      intervalMs: 600_000,
      description: describeCron(expression),
    });
  });

  it('returns empty fields for a missing expression', () => {
    expect(getCronSchedule()).toEqual({
      expression: '',
      intervalMs: 0,
      description: '',
    });
    expect(getCronSchedule('')).toEqual(getCronSchedule());
  });

  it('preserves unknown expressions without inventing an interval', () => {
    expect(getCronSchedule('invalid-schedule')).toEqual({
      expression: 'invalid-schedule',
      intervalMs: 0,
      description: 'invalid-schedule',
    });
    expect(getCronSchedule('3 7 * * *')).toEqual({
      expression: '3 7 * * *',
      intervalMs: 0,
      description: describeCron('3 7 * * *'),
    });
  });
});
