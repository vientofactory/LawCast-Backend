import cronstrue from 'cronstrue/i18n';
import { describeCron } from './cron-display.util';

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
