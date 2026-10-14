import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Terminal lifecycle states a `notice_archives` row may hold. Use these
 * constants instead of raw string literals so call sites can't drift from
 * the values the immutability trigger and diffchain logic actually expect.
 */
export const NOTICE_LIFECYCLE_STATUS = {
  ACTIVE: 'active',
  SOURCE_DELETED: 'source_deleted',
  RENUMBERED: 'renumbered',
} as const;

export type NoticeLifecycleStatus =
  (typeof NOTICE_LIFECYCLE_STATUS)[keyof typeof NOTICE_LIFECYCLE_STATUS];

@Entity('notice_archives')
@Index('idx_notice_archives_notice_num', ['noticeNum'], { unique: true })
@Index('idx_notice_archives_subject', ['subject'])
@Index('idx_notice_archives_archive_started_at', ['archiveStartedAt'])
@Index('idx_notice_archives_lifecycle_status', ['lifecycleStatus'])
@Index('idx_notice_archives_source_deleted_at', ['sourceDeletedAt'])
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

  aiSummary: string | null;

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

  isDone: boolean;

  @Column({
    type: 'varchar',
    length: 30,
    name: 'lifecycle_status',
    default: 'active',
  })
  lifecycleStatus: NoticeLifecycleStatus;

  @Column({ type: 'datetime', name: 'source_deleted_at', nullable: true })
  sourceDeletedAt: Date | null;

  /**
   * When this notice was last returned by a completed NSM-shaped list scan.
   *
   * Source-deletion detection uses it to turn list absence into an episode that
   * starts when a previously seen row stops being returned, instead of
   * treating every active row the latest scan did not return as a candidate
   * (which re-probed ~10k rows per cycle whenever the scanned list covered a
   * different population than the archive). `NULL` means "not seen since this
   * tracking was introduced".
   */
  @Column({
    type: 'datetime',
    name: 'nsm_last_seen_in_list_at',
    nullable: true,
  })
  nsmLastSeenInListAt: Date | null;

  /**
   * When the NSM detail probe last investigated this row's list absence
   * without confirming a deletion. Bounds re-probing of a row that stays
   * absent (or is never listed by the active source) to once per
   * `ARCHIVE_SYNC_NSM_LIST_ABSENCE_REPROBE_COOLDOWN_HOURS` instead of once per
   * cycle.
   */
  @Column({
    type: 'datetime',
    name: 'nsm_list_absence_probed_at',
    nullable: true,
  })
  nsmListAbsenceProbedAt: Date | null;

  /**
   * How many times the proposalReason retry cron has attempted to recover this
   * row's reason (`제안이유`) from the bill sources.
   *
   * The retry candidate query used to be a plain `noticeNum ASC` page with no
   * memory of earlier attempts, so the lowest-numbered rows were re-seeded on
   * every tick: for rows whose reason exists in no source at all (`사직의건`,
   * `결의안`) each attempt resolved to nothing and the drain dropped them
   * again, starving every later candidate forever. Ordering by this count puts
   * never-attempted rows first, so a newly arrived candidate is served before a
   * row that has already failed.
   */
  @Column({
    type: 'integer',
    name: 'proposal_reason_retry_count',
    default: 0,
  })
  proposalReasonRetryCount: number;

  /**
   * When the proposalReason retry cron last attempted this row. Breaks ties
   * between rows carrying the same attempt count (oldest attempt first), which
   * turns the candidate pool into a rotation instead of a fixed head.
   */
  @Column({
    type: 'datetime',
    name: 'proposal_reason_retried_at',
    nullable: true,
  })
  proposalReasonRetriedAt: Date | null;

  @Column({ type: 'blob', name: 'screenshot_blob', nullable: true })
  screenshotBlob: Buffer | null;

  @Column({
    type: 'varchar',
    length: 10,
    name: 'screenshot_format',
    nullable: true,
  })
  screenshotFormat: string | null;

  @Column({
    type: 'varchar',
    length: 20,
    name: 'screenshot_capture_status',
    nullable: true,
  })
  screenshotCaptureStatus: string | null;

  @Column({
    type: 'text',
    name: 'screenshot_capture_error',
    nullable: true,
  })
  screenshotCaptureError: string | null;

  @CreateDateColumn({ name: 'archive_started_at' })
  archiveStartedAt: Date;
}
