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

  @Column({ type: 'integer', default: 0 })
  numComments: number;

  @Column({ type: 'text' })
  assemblyLink: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  contentId: string | null;

  @Column({ type: 'text', default: '' })
  proposalReason: string;

  @Column({ type: 'text', nullable: true })
  sourceTitle: string | null;

  @Column({ type: 'text', nullable: true })
  aiSummary: string | null;

  @Column({ type: 'varchar', length: 30, default: 'not_requested' })
  aiSummaryStatus: string;

  @Column({ type: 'text', default: '' })
  attachmentPdfFile: string;

  @Column({ type: 'text', default: '' })
  attachmentHwpFile: string;

  @CreateDateColumn({ name: 'archive_started_at' })
  archiveStartedAt: Date;

  @UpdateDateColumn({ name: 'last_updated_at' })
  lastUpdatedAt: Date;
}
