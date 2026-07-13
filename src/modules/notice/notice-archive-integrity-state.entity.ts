import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { type ArchiveIntegrityCheckResult } from './notice-archive-integrity-check.entity';

export type ArchiveIntegrityStatus = 'pending' | ArchiveIntegrityCheckResult;

@Entity('notice_archive_integrity_states')
@Index('idx_notice_archive_integrity_states_notice_num', ['noticeNum'], {
  unique: true,
})
@Index('idx_notice_archive_integrity_states_latest_result_checked_at', [
  'latestResult',
  'latestCheckedAt',
])
export class NoticeArchiveIntegrityState {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'integer', name: 'notice_num' })
  noticeNum: number;

  @Column({ type: 'integer', name: 'latest_check_id', nullable: true })
  latestCheckId: number | null;

  @Column({
    type: 'varchar',
    length: 20,
    name: 'latest_result',
    nullable: true,
  })
  latestResult: ArchiveIntegrityCheckResult | null;

  @Column({ type: 'datetime', name: 'latest_checked_at', nullable: true })
  latestCheckedAt: Date | null;

  @Column({ type: 'datetime', name: 'last_passed_at', nullable: true })
  lastPassedAt: Date | null;

  @Column({ type: 'integer', name: 'failure_streak', default: 0 })
  failureStreak: number;

  @Column({
    type: 'varchar',
    length: 100,
    name: 'last_skip_reason',
    nullable: true,
  })
  lastSkipReason: string | null;

  @Column({
    type: 'varchar',
    length: 64,
    name: 'latest_stored_sha256',
    nullable: true,
  })
  latestStoredSha256: string | null;

  @Column({
    type: 'varchar',
    length: 64,
    name: 'latest_calculated_sha256',
    nullable: true,
  })
  latestCalculatedSha256: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
