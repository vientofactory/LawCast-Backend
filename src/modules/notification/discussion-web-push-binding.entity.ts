import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('discussion_web_push_bindings')
@Index('idx_discussion_web_push_bindings_lookup', [
  'threadId',
  'authorId',
  'isActive',
])
@Index('idx_discussion_web_push_bindings_subscription', [
  'subscriptionId',
  'isActive',
])
@Index(
  'idx_discussion_web_push_bindings_unique',
  ['threadId', 'authorId', 'subscriptionId'],
  {
    unique: true,
  },
)
export class DiscussionWebPushBinding {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'thread_id', type: 'integer' })
  threadId: number;

  @Column({ name: 'author_id', type: 'varchar', length: 64 })
  authorId: string;

  @Column({ name: 'subscription_id', type: 'integer' })
  subscriptionId: number;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
