import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NoticeChangeEvent } from './notice-change-event.entity';
import { NoticeChangeDetail } from './notice-change-detail.entity';
import { ChangeTrackingService } from './change-tracking.service';
import { NotificationModule } from '../notification/notification.module';

@Module({
  imports: [
    NotificationModule,
    TypeOrmModule.forFeature([NoticeChangeEvent, NoticeChangeDetail]),
  ],
  providers: [ChangeTrackingService],
  exports: [ChangeTrackingService],
})
export class ChangeTrackingModule {}
