import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type ChangeDetailType = 'added' | 'removed' | 'modified';

@Entity('notice_change_details')
@Index('idx_notice_change_details_event_id', ['eventId'])
@Index('idx_notice_change_details_field_path', ['fieldPath'])
export class NoticeChangeDetail {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'integer', name: 'event_id' })
  eventId: number;

  @Column({ type: 'varchar', length: 255, name: 'field_path' })
  fieldPath: string;

  @Column({ type: 'varchar', length: 20, name: 'change_type' })
  changeType: ChangeDetailType;

  @Column({ type: 'text', name: 'before_value', nullable: true })
  beforeValue: string | null;

  @Column({ type: 'text', name: 'after_value', nullable: true })
  afterValue: string | null;

  @Column({ type: 'varchar', length: 64, name: 'before_hash', nullable: true })
  beforeHash: string | null;

  @Column({ type: 'varchar', length: 64, name: 'after_hash', nullable: true })
  afterHash: string | null;
}
