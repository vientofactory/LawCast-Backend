import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type ArchiveIntegrityCheckResult = 'passed' | 'failed' | 'skipped';

@Entity('notice_archive_integrity_checks')
@Index('idx_notice_archive_integrity_checks_notice_num_checked_at', [
  'noticeNum',
  'checkedAt',
])
@Index('idx_notice_archive_integrity_checks_result_checked_at', [
  'checkResult',
  'checkedAt',
])
export class NoticeArchiveIntegrityCheck {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'integer', name: 'notice_num' })
  noticeNum: number;

  @Column({ type: 'datetime', name: 'checked_at' })
  checkedAt: Date;

  @Column({
    type: 'varchar',
    length: 64,
    name: 'stored_sha256',
    nullable: true,
  })
  storedSha256: string | null;

  @Column({
    type: 'varchar',
    length: 64,
    name: 'calculated_sha256',
    nullable: true,
  })
  calculatedSha256: string | null;

  @Column({ type: 'varchar', length: 20, name: 'check_result' })
  checkResult: ArchiveIntegrityCheckResult;

  @Column({ type: 'varchar', length: 100, name: 'skip_reason', nullable: true })
  skipReason: string | null;

  @Column({ type: 'varchar', length: 40, name: 'verifier_version' })
  verifierVersion: string;

  @Column({ type: 'text', name: 'diagnostics_json', nullable: true })
  diagnosticsJson: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
