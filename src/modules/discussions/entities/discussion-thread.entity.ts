import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { DiscussionComment } from './discussion-comment.entity';

export type DiscussionThreadStatus = 'open' | 'closed';

@Entity('discussion_threads')
@Index('idx_discussion_threads_notice_num', ['noticeNum'])
@Index('idx_discussion_threads_notice_num_updated_at', [
  'noticeNum',
  'updatedAt',
])
export class DiscussionThread {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'notice_num', type: 'integer' })
  noticeNum: number;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'varchar', length: 20, default: 'open' })
  status: DiscussionThreadStatus;

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

  @Column({ name: 'comment_count', type: 'integer', default: 1 })
  commentCount: number;

  @OneToMany(() => DiscussionComment, (comment) => comment.thread)
  comments: DiscussionComment[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
