import { parsePositiveInteger, parseIsoDate } from './query-parsing.utils';

describe('parsePositiveInteger', () => {
  it('returns undefined for undefined input', () => {
    expect(parsePositiveInteger(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(parsePositiveInteger('')).toBeUndefined();
  });

  it('returns undefined for whitespace-only string', () => {
    expect(parsePositiveInteger('   ')).toBeUndefined();
  });

  it('parses a valid positive integer string', () => {
    expect(parsePositiveInteger('42')).toBe(42);
  });

  it('parses "1" as the minimum valid value', () => {
    expect(parsePositiveInteger('1')).toBe(1);
  });

  it('returns undefined for zero', () => {
    expect(parsePositiveInteger('0')).toBeUndefined();
  });

  it('returns undefined for negative numbers', () => {
    expect(parsePositiveInteger('-5')).toBeUndefined();
  });

  it('returns undefined for non-numeric strings', () => {
    expect(parsePositiveInteger('abc')).toBeUndefined();
  });

  it('parseInt is lenient: "3.14" parses to 3 (parseInt truncates)', () => {
    // parseInt('3.14') returns 3, and 3 is a valid positive integer
    expect(parsePositiveInteger('3.14')).toBe(3);
  });

  it('handles large integer strings that fit within safe integer range', () => {
    // parseInt can handle up to Number.MAX_SAFE_INTEGER
    expect(parsePositiveInteger('9007199254740991')).toBe(9007199254740991);
  });

  it('trims whitespace before parsing', () => {
    expect(parsePositiveInteger('  10  ')).toBe(10);
  });

  it('truncates leading/trailing characters that form a valid integer', () => {
    // "123abc" parseInt returns 123 but Number.isInteger check passes
    // The function uses parseInt which is lenient — "123abc" → 123
    expect(parsePositiveInteger('123abc')).toBe(123);
  });
});

describe('parseIsoDate', () => {
  it('returns undefined for undefined input', () => {
    expect(parseIsoDate(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(parseIsoDate('')).toBeUndefined();
  });

  it('returns undefined for whitespace-only string', () => {
    expect(parseIsoDate('   ')).toBeUndefined();
  });

  it('parses a valid ISO date string', () => {
    const result = parseIsoDate('2026-09-13');
    expect(result).toBeInstanceOf(Date);
    expect(result!.getFullYear()).toBe(2026);
  });

  it('parses a full ISO datetime string', () => {
    const result = parseIsoDate('2026-09-13T10:30:00Z');
    expect(result).toBeInstanceOf(Date);
    expect(result!.getUTCHours()).toBe(10);
  });

  it('returns undefined for an invalid date string', () => {
    expect(parseIsoDate('not-a-date')).toBeUndefined();
  });

  it('returns undefined for a date-only format that Date cannot parse', () => {
    // "2026-13-45" is invalid
    expect(parseIsoDate('2026-13-45')).toBeUndefined();
  });
});
