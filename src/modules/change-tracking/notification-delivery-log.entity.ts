import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type NotificationDeliveryStatus = 'delivered' | 'failed' | 'deactivated';

@Entity('notification_delivery_logs')
@Index('idx_notification_delivery_logs_event_id_delivered_at', [
  'eventId',
  'deliveredAt',
])
@Index('idx_notification_delivery_logs_webhook_id', ['webhookId'])
@Index('idx_notification_delivery_logs_payload_hash', ['payloadHash'])
export class NotificationDeliveryLog {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'integer', name: 'event_id' })
  eventId: number;

  @Column({ type: 'integer', name: 'webhook_id', nullable: true })
  webhookId: number | null;

  @Column({ type: 'datetime', name: 'delivered_at' })
  deliveredAt: Date;

  @Column({ type: 'varchar', length: 30, name: 'status' })
  status: NotificationDeliveryStatus;

  @Column({ type: 'varchar', length: 64, name: 'payload_hash' })
  payloadHash: string;

  @Column({ type: 'integer', name: 'response_code', nullable: true })
  responseCode: number | null;

  @Column({ type: 'text', name: 'error_message', nullable: true })
  errorMessage: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
