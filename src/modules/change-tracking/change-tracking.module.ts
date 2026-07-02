import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NoticeChangeEvent } from './notice-change-event.entity';
import { NoticeChangeDetail } from './notice-change-detail.entity';
import { NotificationDeliveryLog } from './notification-delivery-log.entity';
import { ChangeTrackingService } from './change-tracking.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      NoticeChangeEvent,
      NoticeChangeDetail,
      NotificationDeliveryLog,
    ]),
  ],
  providers: [ChangeTrackingService],
  exports: [ChangeTrackingService],
})
export class ChangeTrackingModule {}
