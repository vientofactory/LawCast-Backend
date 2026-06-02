import { MigrationInterface } from 'typeorm';
import { InitialSchemaMigration1744953900000 } from './202604170001-initial-schema.migration';
import { AddContentMetadataColumns1745001601000 } from './202604180001-add-content-metadata-columns.migration';
import { AddIsDoneColumn1746316801000 } from './202605030001-add-is-done-column.migration';
import { AddScreenshotBlob1748476800000 } from './202605290001-add-screenshot-blob.migration';
import { RestoreNoticeNumUniqueIndex1748563200000 } from './202605300001-restore-notice-num-unique-index.migration';
import { AddPerfIndexes1748822400000 } from './202606020001-add-perf-indexes.migration';

export const migrations: (new () => MigrationInterface)[] = [
  InitialSchemaMigration1744953900000,
  AddContentMetadataColumns1745001601000,
  AddIsDoneColumn1746316801000,
  AddScreenshotBlob1748476800000,
  RestoreNoticeNumUniqueIndex1748563200000,
  AddPerfIndexes1748822400000,
];
