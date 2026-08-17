import { describe, expect, it } from '@jest/globals';
import { NoticeChangeSource } from './notice-change-source.enum';
import {
  CURRENT_CANON_VERSION,
  DEFAULT_TRACKED_FIELDS,
  LEGACY_TRACKED_FIELDS_V1,
  getTrackedFieldsForCanonVersion,
  getTrackedFieldsForChangeEvent,
} from './change-tracking-diff.utils';

describe('getTrackedFieldsForChangeEvent', () => {
  it('uses DEFAULT_TRACKED_FIELDS for pre-versioned archive:upsert events that recorded contentId', () => {
    const fields = getTrackedFieldsForChangeEvent({
      source: NoticeChangeSource.ARCHIVE_UPSERT,
      canonVersion: 1,
      preVersionedArchiveUpsert: true,
    });

    expect(fields).toEqual(DEFAULT_TRACKED_FIELDS);
    expect(fields).toContain('contentId');
  });

  it('keeps LEGACY_TRACKED_FIELDS_V1 for ordinary v1 events without contentId tracking', () => {
    const fields = getTrackedFieldsForChangeEvent({
      source: NoticeChangeSource.ARCHIVE_UPSERT,
      canonVersion: 1,
      preVersionedArchiveUpsert: false,
    });

    expect(fields).toEqual(LEGACY_TRACKED_FIELDS_V1);
    expect(fields).not.toContain('contentId');
  });

  it('keeps LEGACY_TRACKED_FIELDS_V1 for pre-versioned events from non-archive sources', () => {
    const fields = getTrackedFieldsForChangeEvent({
      source: NoticeChangeSource.ARCHIVE_IS_DONE_SYNC,
      canonVersion: 1,
      preVersionedArchiveUpsert: true,
    });

    expect(fields).toEqual(LEGACY_TRACKED_FIELDS_V1);
  });

  it('uses DEFAULT_TRACKED_FIELDS for canonVersion >= 2 regardless of source', () => {
    const fields = getTrackedFieldsForChangeEvent({
      source: NoticeChangeSource.ARCHIVE_IS_DONE_SYNC,
      canonVersion: CURRENT_CANON_VERSION,
      preVersionedArchiveUpsert: false,
    });

    expect(fields).toEqual(DEFAULT_TRACKED_FIELDS);
  });
});

describe('getTrackedFieldsForCanonVersion', () => {
  it('keeps the v1 field set stable so historical hashes stay reproducible', () => {
    expect(getTrackedFieldsForCanonVersion(1)).toEqual(
      LEGACY_TRACKED_FIELDS_V1,
    );
    expect(getTrackedFieldsForCanonVersion(0)).toEqual(
      LEGACY_TRACKED_FIELDS_V1,
    );
  });

  it('tracks contentId from canon v2 onwards', () => {
    expect(getTrackedFieldsForCanonVersion(2)).toEqual(DEFAULT_TRACKED_FIELDS);
    expect(getTrackedFieldsForCanonVersion(3)).toEqual(DEFAULT_TRACKED_FIELDS);
  });
});
