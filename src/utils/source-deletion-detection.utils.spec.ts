import { afterEach, describe, expect, it } from '@jest/globals';
import {
  describeNsmDeletionDetectionDisabled,
  getNsmDeletionDetectionDisabledReason,
  isNsmDeletionDetectionEnabled,
} from './source-deletion-detection.utils';

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

describe('isNsmDeletionDetectionEnabled with the LIKMS source', () => {
  afterEach(() => {
    delete process.env.CRAWLING_NSM_DELETION_DETECTION_ENABLED;
    delete process.env.CRAWLING_NSM_SOURCE;
  });

  it('forces detection off while the active source is likms', () => {
    process.env.CRAWLING_NSM_SOURCE = 'likms';

    expect(isNsmDeletionDetectionEnabled()).toBe(false);
    expect(getNsmDeletionDetectionDisabledReason()).toBe('likms-source');
  });

  it('ignores an explicit enable value while the source is likms', () => {
    process.env.CRAWLING_NSM_SOURCE = 'likms';
    process.env.CRAWLING_NSM_DELETION_DETECTION_ENABLED = 'true';

    expect(isNsmDeletionDetectionEnabled()).toBe(false);
  });

  it('follows the env var again once the source goes back to nsm', () => {
    process.env.CRAWLING_NSM_SOURCE = 'likms';
    expect(isNsmDeletionDetectionEnabled()).toBe(false);

    process.env.CRAWLING_NSM_SOURCE = 'nsm';
    expect(isNsmDeletionDetectionEnabled()).toBe(true);
    expect(getNsmDeletionDetectionDisabledReason()).toBeNull();

    process.env.CRAWLING_NSM_DELETION_DETECTION_ENABLED = 'false';
    expect(getNsmDeletionDetectionDisabledReason()).toBe('env');
  });

  it('explains the portal mismatch for skip logs', () => {
    process.env.CRAWLING_NSM_SOURCE = 'likms';

    const description = describeNsmDeletionDetectionDisabled();
    expect(description).toContain('likms');
    expect(description).toContain('opinion.lawmaking.go.kr');
  });

  it('names the env key when the env var is the reason', () => {
    process.env.CRAWLING_NSM_DELETION_DETECTION_ENABLED = 'false';

    expect(describeNsmDeletionDetectionDisabled()).toContain(
      'CRAWLING_NSM_DELETION_DETECTION_ENABLED',
    );
  });
});
