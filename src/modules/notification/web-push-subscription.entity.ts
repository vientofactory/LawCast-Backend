import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('web_push_subscriptions')
@Index('idx_web_push_subscriptions_endpoint_unique', ['endpoint'], {
  unique: true,
})
@Index('idx_web_push_subscriptions_is_active_updated_at', [
  'isActive',
  'updatedAt',
])
export class WebPushSubscription {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'text' })
  endpoint: string;

  @Column({ type: 'text' })
  p256dh: string;

  @Column({ type: 'text' })
  auth: string;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  @Column({ name: 'user_agent', type: 'text', nullable: true })
  userAgent: string | null;

  @Column({ name: 'last_notified_at', type: 'datetime', nullable: true })
  lastNotifiedAt: Date | null;

  @Column({ name: 'failure_count', type: 'integer', default: 0 })
  failureCount: number;

  @Column({ name: 'last_failure_reason', type: 'text', nullable: true })
  lastFailureReason: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
