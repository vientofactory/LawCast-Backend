import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('notice_archives')
@Index('idx_notice_archives_notice_num', ['noticeNum'], { unique: true })
@Index('idx_notice_archives_subject', ['subject'])
export class NoticeArchive {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'integer' })
  noticeNum: number;

  @Column({ type: 'varchar', length: 500 })
  subject: string;

  @Column({ type: 'varchar', length: 100 })
  proposerCategory: string;

  @Column({ type: 'varchar', length: 200 })
  committee: string;

  @Column({ type: 'text' })
  assemblyLink: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  contentId: string | null;

  @Column({ type: 'text', default: '' })
  proposalReason: string;

  @Column({ type: 'text', nullable: true })
  sourceTitle: string | null;

  @Column({
    type: 'varchar',
    length: 100,
    name: 'content_bill_number',
    nullable: true,
  })
  contentBillNumber: string | null;

  @Column({
    type: 'varchar',
    length: 255,
    name: 'content_proposer',
    nullable: true,
  })
  contentProposer: string | null;

  @Column({
    type: 'varchar',
    length: 100,
    name: 'content_proposal_date',
    nullable: true,
  })
  contentProposalDate: string | null;

  @Column({
    type: 'varchar',
    length: 200,
    name: 'content_committee',
    nullable: true,
  })
  contentCommittee: string | null;

  @Column({
    type: 'varchar',
    length: 100,
    name: 'content_referral_date',
    nullable: true,
  })
  contentReferralDate: string | null;

  @Column({
    type: 'varchar',
    length: 200,
    name: 'content_notice_period',
    nullable: true,
  })
  contentNoticePeriod: string | null;

  @Column({
    type: 'varchar',
    length: 200,
    name: 'content_proposal_session',
    nullable: true,
  })
  contentProposalSession: string | null;

  @Column({ type: 'text', nullable: true })
  aiSummary: string | null;

  @Column({ type: 'varchar', length: 30, default: 'not_requested' })
  aiSummaryStatus: string;

  @Column({ type: 'text', default: '' })
  attachmentPdfFile: string;

  @Column({ type: 'text', default: '' })
  attachmentHwpFile: string;

  @Column({ type: 'datetime', name: 'archived_at', nullable: true })
  archivedAt: Date | null;

  @Column({ type: 'text', name: 'source_html', nullable: true })
  sourceHtml: string | null;

  @Column({
    type: 'varchar',
    length: 64,
    name: 'source_html_sha256',
    nullable: true,
  })
  sourceHtmlSha256: string | null;

  @Column({ type: 'datetime', name: 'integrity_verified_at', nullable: true })
  integrityVerifiedAt: Date | null;

  @Column({ type: 'boolean', name: 'integrity_check_passed', nullable: true })
  integrityCheckPassed: boolean | null;

  @Column({ type: 'text', name: 'http_metadata_json', nullable: true })
  httpMetadataJson: string | null;

  @Column({ type: 'datetime', name: 'http_fetched_at', nullable: true })
  httpFetchedAt: Date | null;

  @Column({ type: 'integer', name: 'http_status_code', nullable: true })
  httpStatusCode: number | null;

  @Column({
    type: 'varchar',
    length: 255,
    name: 'http_content_type',
    nullable: true,
  })
  httpContentType: string | null;

  @Column({ type: 'varchar', length: 255, name: 'http_etag', nullable: true })
  httpEtag: string | null;

  @Column({
    type: 'varchar',
    length: 255,
    name: 'http_last_modified',
    nullable: true,
  })
  httpLastModified: string | null;

  @CreateDateColumn({ name: 'archive_started_at' })
  archiveStartedAt: Date;

  @UpdateDateColumn({ name: 'last_updated_at' })
  lastUpdatedAt: Date;
}
