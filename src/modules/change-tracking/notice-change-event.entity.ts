import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type ChangeEventType =
  | 'created'
  | 'updated'
  | 'redacted'
  | 'invalidated';

@Entity('notice_change_events')
@Index('idx_notice_change_events_notice_num_detected_at', [
  'noticeNum',
  'detectedAt',
])
@Index('idx_notice_change_events_detected_at', ['detectedAt'])
@Index(
  'idx_notice_change_events_notice_num_event_height_unique',
  ['noticeNum', 'eventHeight'],
  {
    unique: true,
  },
)
@Index('idx_notice_change_events_event_hash_unique', ['eventHash'], {
  unique: true,
})
export class NoticeChangeEvent {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'integer', name: 'notice_num' })
  noticeNum: number;

  @Column({ type: 'datetime', name: 'detected_at' })
  detectedAt: Date;

  @Column({ type: 'varchar', length: 40, name: 'event_type' })
  eventType: ChangeEventType;

  @Column({ type: 'varchar', length: 80, nullable: true })
  source: string | null;

  @Column({ type: 'integer', name: 'event_height' })
  eventHeight: number;

  @Column({
    type: 'varchar',
    length: 64,
    name: 'prev_event_hash',
    nullable: true,
  })
  prevEventHash: string | null;

  @Column({ type: 'varchar', length: 64, name: 'event_hash' })
  eventHash: string;

  @Column({ type: 'integer', name: 'changed_field_count', default: 0 })
  changedFieldCount: number;

  @Column({ type: 'text', name: 'diff_summary_json', nullable: true })
  diffSummaryJson: string | null;

  @Column({
    type: 'varchar',
    length: 64,
    name: 'crawler_run_id',
    nullable: true,
  })
  crawlerRunId: string | null;

  @Column({ type: 'varchar', length: 20, name: 'hash_algo', default: 'sha256' })
  hashAlgo: string;

  @Column({ type: 'integer', name: 'canon_version', default: 1 })
  canonVersion: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
