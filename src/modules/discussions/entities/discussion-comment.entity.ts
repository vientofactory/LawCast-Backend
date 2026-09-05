import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { DiscussionThread } from './discussion-thread.entity';

@Entity('discussion_comments')
@Index('idx_discussion_comments_thread_id', ['threadId'])
@Index('idx_discussion_comments_notice_num', ['noticeNum'])
@Index('idx_discussion_comments_thread_id_seq', ['threadId', 'sequence'])
export class DiscussionComment {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'thread_id', type: 'integer' })
  threadId: number;

  @Column({ name: 'notice_num', type: 'integer' })
  noticeNum: number;

  @Column({ type: 'integer' })
  sequence: number;

  @Column({
    name: 'author_nickname',
    type: 'varchar',
    length: 100,
    default: '익명',
  })
  authorNickname: string;

  @Column({ name: 'author_ip_masked', type: 'varchar', length: 50 })
  authorIpMasked: string;

  @Column({ name: 'author_ip_hash', type: 'varchar', length: 64 })
  authorIpHash: string;

  @Column({ name: 'password_hash', type: 'varchar', length: 128 })
  passwordHash: string;

  @Column({ name: 'password_salt', type: 'varchar', length: 64 })
  passwordSalt: string;

  @Column({ type: 'text' })
  content: string;

  @Column({ name: 'is_deleted', type: 'boolean', default: false })
  isDeleted: boolean;

  @Column({ name: 'is_edited', type: 'boolean', default: false })
  isEdited: boolean;

  @Column({ name: 'edited_at', type: 'datetime', nullable: true })
  editedAt: Date | null;

  @ManyToOne(() => DiscussionThread, (thread) => thread.comments, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'thread_id' })
  thread: DiscussionThread;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
