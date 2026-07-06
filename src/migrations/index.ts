import type { MigrationInterface } from 'typeorm';
import { InitialSchemaMigration1744953900000 } from './202604170001-initial-schema.migration';
import { AddContentMetadataColumns1745001601000 } from './202604180001-add-content-metadata-columns.migration';
import { AddIsDoneColumn1746316801000 } from './202605030001-add-is-done-column.migration';
import { AddScreenshotBlob1748476800000 } from './202605290001-add-screenshot-blob.migration';
import { RestoreNoticeNumUniqueIndex1748563200000 } from './202605300001-restore-notice-num-unique-index.migration';
import { AddPerfIndexes1748822400000 } from './202606020001-add-perf-indexes.migration';
import { AddChangeTrackingTables1751500801000 } from './202607030001-add-change-tracking-tables.migration';
import { AddArchiveLifecycleAndNoDelete1751587201000 } from './202607040001-add-archive-lifecycle-and-no-delete.migration';
import { AddQueryOptimizationIndexes1751590802000 } from './202607040002-add-query-optimization-indexes.migration';
import { RestoreContaminatedProposalReasonSnapshots1751760001000 } from './202607060001-restore-contaminated-proposal-reason-snapshots.migration';
import { AddNoticeArchiveSummaryStates1751760002000 } from './202607060002-add-notice-archive-summary-states.migration';
import { RemoveArchiveSummaryColumns1751760003000 } from './202607060003-remove-archive-summary-columns.migration';
import { RemoveNoticeArchiveImmutabilityTriggers1751760004000 } from './202607060004-remove-notice-archive-immutability-triggers.migration';

export const migrations: (new () => MigrationInterface)[] = [
  InitialSchemaMigration1744953900000,
  AddContentMetadataColumns1745001601000,
  AddIsDoneColumn1746316801000,
  AddScreenshotBlob1748476800000,
  RestoreNoticeNumUniqueIndex1748563200000,
  AddPerfIndexes1748822400000,
  AddChangeTrackingTables1751500801000,
  AddArchiveLifecycleAndNoDelete1751587201000,
  AddQueryOptimizationIndexes1751590802000,
  RestoreContaminatedProposalReasonSnapshots1751760001000,
  AddNoticeArchiveSummaryStates1751760002000,
  RemoveArchiveSummaryColumns1751760003000,
  RemoveNoticeArchiveImmutabilityTriggers1751760004000,
];
