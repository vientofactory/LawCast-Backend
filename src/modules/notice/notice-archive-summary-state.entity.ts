import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('notice_archive_summary_states')
@Index('idx_notice_archive_summary_states_notice_num', ['noticeNum'], {
  unique: true,
})
@Index('idx_notice_archive_summary_states_status_notice_num', [
  'aiSummaryStatus',
  'noticeNum',
])
export class NoticeArchiveSummaryState {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'integer', name: 'notice_num' })
  noticeNum: number;

  @Column({ type: 'text', name: 'ai_summary', nullable: true })
  aiSummary: string | null;

  @Column({ type: 'varchar', length: 30, name: 'ai_summary_status' })
  aiSummaryStatus: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
