import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { type EntityManager, In, Repository } from 'typeorm';
import {
  NoticeChangeEvent,
  type ChangeEventType,
} from './notice-change-event.entity';
import {
  NoticeChangeDetail,
  type ChangeDetailType,
} from './notice-change-detail.entity';
import {
  canonicalStringify,
  computeDiff,
  sha256Hex,
  type DiffComputationResult,
} from './change-tracking-diff.utils';
import { type ChangeNotificationPayload } from '../notification/notification.service';
import { NotificationBatchService } from '../notification/notification-batch.service';

interface AppendChangeEventInput {
  noticeNum: number;
  eventType: ChangeEventType;
  eventHash: string;
  detectedAt?: Date;
  source?: string | null;
  changedFieldCount?: number;
  diffSummaryJson?: string | null;
  crawlerRunId?: string | null;
  hashAlgo?: string;
  canonVersion?: number;
}

interface AppendChangeEventWithDetailsInput extends AppendChangeEventInput {
  details?: ChangeDetailInput[];
  maxRetries?: number;
}

interface ChangeDetailInput {
  fieldPath: string;
  changeType: ChangeDetailType;
  beforeValue?: string | null;
  afterValue?: string | null;
  beforeHash?: string | null;
  afterHash?: string | null;
}

interface BuildDiffEventInput {
  noticeNum: number;
  beforeSnapshot: Record<string, unknown> | null;
  afterSnapshot: Record<string, unknown>;
  detectedAt?: Date;
  source?: string | null;
  trackedFields?: readonly string[];
  hashAlgo?: string;
  canonVersion?: number;
}

interface BuildDiffEventOutput {
  shouldAppend: boolean;
  eventType: ChangeEventType;
  diff: DiffComputationResult;
  eventHash: string;
  detectedAt: Date;
  hashAlgo: string;
  canonVersion: number;
}

interface DispatchChangeNotificationInput {
  event: NoticeChangeEvent;
  subject: string;
  changedFields: string[];
}

interface ChangeTimelineQuery {
  noticeNum: number;
  limit?: number;
}

interface RecentChangesQuery {
  page: number;
  limit: number;
  eventType?: ChangeEventType;
}

export interface ChangeTimelineItem {
  id: number;
  noticeNum: number;
  detectedAt: Date;
  eventType: ChangeEventType;
  source: string | null;
  eventHeight: number;
  prevEventHash: string | null;
  eventHash: string;
  changedFieldCount: number;
  hashAlgo: string;
  canonVersion: number;
  diffSummary: Record<string, unknown> | null;
  details: Array<{
    id: number;
    fieldPath: string;
    changeType: ChangeDetailType;
    beforeValue: string | null;
    afterValue: string | null;
    beforeHash: string | null;
    afterHash: string | null;
  }>;
}

export interface RecentChangeItem {
  id: number;
  noticeNum: number;
  detectedAt: Date;
  eventType: ChangeEventType;
  source: string | null;
  eventHeight: number;
  eventHash: string;
  changedFieldCount: number;
  diffSummary: Record<string, unknown> | null;
}

export interface RecentChangesResult {
  items: RecentChangeItem[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

@Injectable()
export class ChangeTrackingService {
  private readonly logger = new Logger(ChangeTrackingService.name);
  private readonly APPEND_EVENT_MAX_RETRIES = 3;
  private readonly queuedChangeNotifications: ChangeNotificationPayload[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private isFlushingQueuedNotifications = false;
  private notificationCollectionDepth = 0;

  constructor(
    @InjectRepository(NoticeChangeEvent)
    private readonly changeEventRepository: Repository<NoticeChangeEvent>,
    @InjectRepository(NoticeChangeDetail)
    private readonly changeDetailRepository: Repository<NoticeChangeDetail>,
    @Optional()
    private readonly notificationBatchService?: NotificationBatchService,
  ) {}

  async getLastEventForNotice(
    noticeNum: number,
  ): Promise<NoticeChangeEvent | null> {
    return this.changeEventRepository.findOne({
      where: { noticeNum },
      order: { eventHeight: 'DESC' },
    });
  }

  /**
   * Appends a single change event.
   * The method enforces per-notice hash-chain linkage at the application level.
   */
  async appendChangeEvent(
    input: AppendChangeEventInput,
  ): Promise<NoticeChangeEvent> {
    const lastEvent = await this.getLastEventForNotice(input.noticeNum);

    const event = this.changeEventRepository.create({
      noticeNum: input.noticeNum,
      detectedAt: input.detectedAt ?? new Date(),
      eventType: input.eventType,
      source: input.source ?? null,
      eventHeight: (lastEvent?.eventHeight ?? 0) + 1,
      prevEventHash: lastEvent?.eventHash ?? null,
      eventHash: input.eventHash,
      changedFieldCount: input.changedFieldCount ?? 0,
      diffSummaryJson: input.diffSummaryJson ?? null,
      crawlerRunId: input.crawlerRunId ?? null,
      hashAlgo: input.hashAlgo ?? 'sha256',
      canonVersion: input.canonVersion ?? 1,
    });

    const saved = await this.changeEventRepository.save(event);
    this.logger.debug(
      `Appended change event notice=${saved.noticeNum} height=${saved.eventHeight} hash=${saved.eventHash}`,
    );
    return saved;
  }

  async appendChangeDetails(
    eventId: number,
    details: ChangeDetailInput[],
  ): Promise<void> {
    if (details.length === 0) return;

    const rows = details.map((detail) =>
      this.changeDetailRepository.create({
        eventId,
        fieldPath: detail.fieldPath,
        changeType: detail.changeType,
        beforeValue: detail.beforeValue ?? null,
        afterValue: detail.afterValue ?? null,
        beforeHash: detail.beforeHash ?? null,
        afterHash: detail.afterHash ?? null,
      }),
    );

    await this.changeDetailRepository.save(rows);
  }

  /**
   * Atomically appends a chain event header and its detail rows in one DB transaction.
   * Retries on per-notice event-height unique conflicts caused by concurrent writers.
   */
  async appendChangeEventWithDetails(
    input: AppendChangeEventWithDetailsInput,
  ): Promise<NoticeChangeEvent> {
    const details = input.details ?? [];
    const maxRetries = Math.max(
      input.maxRetries ?? this.APPEND_EVENT_MAX_RETRIES,
      1,
    );

    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      try {
        const saved = await this.changeEventRepository.manager.transaction(
          async (manager) =>
            this.appendEventAndDetailsInTransaction(manager, input, details),
        );

        this.logger.debug(
          `Appended change event notice=${saved.noticeNum} height=${saved.eventHeight} hash=${saved.eventHash}`,
        );
        return saved;
      } catch (error) {
        if (this.isEventHeightConflictError(error) && attempt < maxRetries) {
          this.logger.warn(
            `Change event append conflict for notice=${input.noticeNum}, retrying (${attempt}/${maxRetries})`,
          );
          continue;
        }
        throw error;
      }
    }

    throw new Error(
      `Failed to append change event after ${maxRetries} attempts for notice=${input.noticeNum}`,
    );
  }

  private async appendEventAndDetailsInTransaction(
    manager: EntityManager,
    input: AppendChangeEventInput,
    details: ChangeDetailInput[],
  ): Promise<NoticeChangeEvent> {
    const eventRepo = manager.getRepository(NoticeChangeEvent);
    const detailRepo = manager.getRepository(NoticeChangeDetail);

    const lastEvent = await eventRepo.findOne({
      where: { noticeNum: input.noticeNum },
      order: { eventHeight: 'DESC' },
    });

    const event = eventRepo.create({
      noticeNum: input.noticeNum,
      detectedAt: input.detectedAt ?? new Date(),
      eventType: input.eventType,
      source: input.source ?? null,
      eventHeight: (lastEvent?.eventHeight ?? 0) + 1,
      prevEventHash: lastEvent?.eventHash ?? null,
      eventHash: input.eventHash,
      changedFieldCount: input.changedFieldCount ?? 0,
      diffSummaryJson: input.diffSummaryJson ?? null,
      crawlerRunId: input.crawlerRunId ?? null,
      hashAlgo: input.hashAlgo ?? 'sha256',
      canonVersion: input.canonVersion ?? 1,
    });

    const saved = await eventRepo.save(event);

    if (details.length > 0) {
      const rows = details.map((detail) =>
        detailRepo.create({
          eventId: saved.id,
          fieldPath: detail.fieldPath,
          changeType: detail.changeType,
          beforeValue: detail.beforeValue ?? null,
          afterValue: detail.afterValue ?? null,
          beforeHash: detail.beforeHash ?? null,
          afterHash: detail.afterHash ?? null,
        }),
      );

      await detailRepo.save(rows);
    }

    return saved;
  }

  private isEventHeightConflictError(error: unknown): boolean {
    const extractErrorMeta = (
      value: unknown,
    ): {
      code: string;
      constraint: string;
      message: string;
      detail: string;
      errno: number | null;
    } => {
      const obj = (value as Record<string, unknown> | undefined) ?? {};
      const code = String(obj.code ?? '').toLowerCase();
      const constraint = String(obj.constraint ?? '').toLowerCase();
      const message = String(obj.message ?? '').toLowerCase();
      const detail = String(obj.detail ?? '').toLowerCase();
      const errnoRaw = obj.errno;
      const errno =
        typeof errnoRaw === 'number'
          ? errnoRaw
          : typeof errnoRaw === 'string'
            ? Number.parseInt(errnoRaw, 10)
            : null;

      return {
        code,
        constraint,
        message,
        detail,
        errno: Number.isNaN(errno ?? Number.NaN) ? null : errno,
      };
    };

    const isTargetConstraint = (text: string): boolean =>
      text.includes(
        'idx_notice_change_events_notice_num_event_height_unique',
      ) ||
      text.includes(
        'notice_change_events.notice_num, notice_change_events.event_height',
      ) ||
      text.includes('notice_num_event_height');

    const isKnownUniqueCode = (meta: {
      code: string;
      errno: number | null;
    }): boolean =>
      meta.code === '23505' ||
      meta.code === 'sqlite_constraint' ||
      meta.code === 'sqlite_constraint_unique' ||
      meta.code === 'er_dup_entry' ||
      meta.errno === 1062;

    const candidates = [error];
    const driverError = (error as { driverError?: unknown } | undefined)
      ?.driverError;
    if (driverError) {
      candidates.push(driverError);
    }

    for (const candidate of candidates) {
      const meta = extractErrorMeta(candidate);
      const joinedText = `${meta.constraint} ${meta.detail} ${meta.message}`;

      if (!isTargetConstraint(joinedText)) {
        continue;
      }

      const hasUniqueViolationText =
        meta.message.includes('unique constraint') ||
        meta.detail.includes('unique constraint') ||
        meta.detail.includes('duplicate key');

      if (isKnownUniqueCode(meta) || hasUniqueViolationText) {
        return true;
      }
    }

    return false;
  }

  /**
   * Phase 2 helper:
   * Computes normalized field-level diffs and builds deterministic event hash.
   */
  buildDiffEvent(input: BuildDiffEventInput): BuildDiffEventOutput {
    const hashAlgo = input.hashAlgo ?? 'sha256';
    const canonVersion = input.canonVersion ?? 1;
    const detectedAt = input.detectedAt ?? new Date();

    const diff = computeDiff(
      input.beforeSnapshot,
      input.afterSnapshot,
      input.trackedFields,
    );

    const isCreated = input.beforeSnapshot === null;
    const eventType: ChangeEventType = isCreated ? 'created' : 'updated';

    // For non-created events, append only when tracked fields changed.
    const shouldAppend = isCreated || diff.changed;

    const hashPayload = canonicalStringify({
      noticeNum: input.noticeNum,
      detectedAt: detectedAt.toISOString(),
      eventType,
      source: input.source ?? null,
      hashAlgo,
      canonVersion,
      before: diff.normalizedBefore,
      after: diff.normalizedAfter,
      details: diff.details,
    });

    const eventHash = sha256Hex(hashPayload);

    return {
      shouldAppend,
      eventType,
      diff,
      eventHash,
      detectedAt,
      hashAlgo,
      canonVersion,
    };
  }

  /**
   * Phase 4 helper:
   * Dispatches change notifications.
   */
  async dispatchChangeNotification(
    input: DispatchChangeNotificationInput,
  ): Promise<void> {
    if (!this.notificationBatchService) {
      return;
    }

    const payload: ChangeNotificationPayload = {
      noticeNum: input.event.noticeNum,
      subject: input.subject,
      eventType: input.event.eventType,
      source: input.event.source,
      changedFields: input.changedFields,
      eventHash: input.event.eventHash,
    };

    this.queuedChangeNotifications.push(payload);
    if (!this.isCollectingChangeNotifications()) {
      this.scheduleQueuedChangeNotificationFlush();
    }
  }

  beginChangeNotificationCollection(): void {
    this.notificationCollectionDepth += 1;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  async endChangeNotificationCollection(): Promise<void> {
    if (this.notificationCollectionDepth === 0) {
      return;
    }

    this.notificationCollectionDepth -= 1;

    if (this.notificationCollectionDepth === 0) {
      await this.flushQueuedChangeNotificationsNow();
    }
  }

  async flushQueuedChangeNotificationsNow(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    await this.flushQueuedChangeNotifications();
  }

  private scheduleQueuedChangeNotificationFlush(): void {
    if (
      this.flushTimer ||
      this.isFlushingQueuedNotifications ||
      this.isCollectingChangeNotifications()
    ) {
      return;
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushQueuedChangeNotifications();
    }, 100);
  }

  private async flushQueuedChangeNotifications(): Promise<void> {
    if (
      !this.notificationBatchService ||
      this.isFlushingQueuedNotifications ||
      this.queuedChangeNotifications.length === 0
    ) {
      return;
    }

    this.isFlushingQueuedNotifications = true;

    const payloads = this.queuedChangeNotifications.splice(
      0,
      this.queuedChangeNotifications.length,
    );

    try {
      const batchJobId =
        await this.notificationBatchService.processChangeNotificationBatch(
          payloads,
          {
            concurrency: 1,
            timeout: 30000,
            retryCount: 2,
            retryDelay: 1000,
          },
        );

      this.logger.debug(
        `Change notification batch dispatched for ${payloads.length} event(s), job=${batchJobId}`,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to dispatch queued change notifications (${payloads.length} event(s)): ${(error as Error).message}`,
      );
    } finally {
      this.isFlushingQueuedNotifications = false;
      if (
        this.queuedChangeNotifications.length > 0 &&
        !this.isCollectingChangeNotifications()
      ) {
        this.scheduleQueuedChangeNotificationFlush();
      }
    }
  }

  private isCollectingChangeNotifications(): boolean {
    return this.notificationCollectionDepth > 0;
  }

  async getNoticeChangeTimeline(
    query: ChangeTimelineQuery,
  ): Promise<ChangeTimelineItem[]> {
    const normalizedLimit = Math.min(Math.max(query.limit ?? 20, 1), 100);

    const events = await this.changeEventRepository.find({
      where: { noticeNum: query.noticeNum },
      order: { detectedAt: 'DESC', eventHeight: 'DESC' },
      take: normalizedLimit,
    });

    if (events.length === 0) {
      return [];
    }

    const eventIds = events.map((event) => event.id);
    const details = await this.changeDetailRepository.find({
      where: { eventId: In(eventIds) },
      order: { id: 'ASC' },
    });

    const detailsByEventId = new Map<number, NoticeChangeDetail[]>();
    for (const detail of details) {
      const bucket = detailsByEventId.get(detail.eventId) ?? [];
      bucket.push(detail);
      detailsByEventId.set(detail.eventId, bucket);
    }

    return events.map((event) => {
      const eventDetails = detailsByEventId.get(event.id) ?? [];

      return {
        id: event.id,
        noticeNum: event.noticeNum,
        detectedAt: event.detectedAt,
        eventType: event.eventType,
        source: event.source,
        eventHeight: event.eventHeight,
        prevEventHash: event.prevEventHash,
        eventHash: event.eventHash,
        changedFieldCount: event.changedFieldCount,
        hashAlgo: event.hashAlgo,
        canonVersion: event.canonVersion,
        diffSummary: this.parseDiffSummary(event.diffSummaryJson),
        details: eventDetails.map((detail) => ({
          id: detail.id,
          fieldPath: detail.fieldPath,
          changeType: detail.changeType,
          beforeValue: detail.beforeValue,
          afterValue: detail.afterValue,
          beforeHash: detail.beforeHash,
          afterHash: detail.afterHash,
        })),
      };
    });
  }

  async getRecentChanges(
    query: RecentChangesQuery,
  ): Promise<RecentChangesResult> {
    const page = Math.max(query.page, 1);
    const limit = Math.min(Math.max(query.limit, 1), 100);
    const where = query.eventType ? { eventType: query.eventType } : {};

    const [items, total] = await this.changeEventRepository.findAndCount({
      where,
      order: { detectedAt: 'DESC', id: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return {
      items: items.map((item) => ({
        id: item.id,
        noticeNum: item.noticeNum,
        detectedAt: item.detectedAt,
        eventType: item.eventType,
        source: item.source,
        eventHeight: item.eventHeight,
        eventHash: item.eventHash,
        changedFieldCount: item.changedFieldCount,
        diffSummary: this.parseDiffSummary(item.diffSummaryJson),
      })),
      page,
      limit,
      total,
      totalPages: total > 0 ? Math.ceil(total / limit) : 1,
    };
  }

  private parseDiffSummary(
    diffSummaryJson: string | null,
  ): Record<string, unknown> | null {
    if (!diffSummaryJson) {
      return null;
    }

    try {
      const parsed = JSON.parse(diffSummaryJson) as unknown;
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
}
