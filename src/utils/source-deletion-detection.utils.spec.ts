import { afterEach, describe, expect, it } from '@jest/globals';
import { isNsmDeletionDetectionEnabled } from './source-deletion-detection.utils';

describe('isNsmDeletionDetectionEnabled', () => {
  afterEach(() => {
    delete process.env.CRAWLING_NSM_DELETION_DETECTION_ENABLED;
  });

  it('defaults to enabled when the env var is not set', () => {
    expect(isNsmDeletionDetectionEnabled()).toBe(true);
  });

  it.each(['1', 'true', 'TRUE', 'yes', 'on', ' true '])(
    'treats %s as enabled',
    (value) => {
      process.env.CRAWLING_NSM_DELETION_DETECTION_ENABLED = value;
      expect(isNsmDeletionDetectionEnabled()).toBe(true);
    },
  );

  it.each(['0', 'false', 'FALSE', 'no', 'off', ' false '])(
    'treats %s as disabled',
    (value) => {
      process.env.CRAWLING_NSM_DELETION_DETECTION_ENABLED = value;
      expect(isNsmDeletionDetectionEnabled()).toBe(false);
    },
  );

  it('falls back to enabled for unrecognized values', () => {
    process.env.CRAWLING_NSM_DELETION_DETECTION_ENABLED = 'banana';
    expect(isNsmDeletionDetectionEnabled()).toBe(true);
  });

  it('reads the env var on every call so it can be toggled at runtime', () => {
    expect(isNsmDeletionDetectionEnabled()).toBe(true);

    process.env.CRAWLING_NSM_DELETION_DETECTION_ENABLED = 'false';
    expect(isNsmDeletionDetectionEnabled()).toBe(false);

    process.env.CRAWLING_NSM_DELETION_DETECTION_ENABLED = 'true';
    expect(isNsmDeletionDetectionEnabled()).toBe(true);
  });
});
