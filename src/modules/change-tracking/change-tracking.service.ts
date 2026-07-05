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
  DEFAULT_TRACKED_FIELDS,
  sha256Hex,
  type DiffComputationResult,
} from './change-tracking-diff.utils';
import {
  NoticeChangeSource,
  NoticeChangeSourcePrefix,
} from './notice-change-source.enum';
import { type ChangeNotificationPayload } from '../notification/notification.service';
import { NotificationBatchService } from '../notification/notification-batch.service';
import { DiscordBridgeService } from '../discord-bridge/discord-bridge.service';
import { BridgeLogLevel } from '../discord-bridge/discord-bridge.types';
import { LoggerUtils } from '../../utils/logger.utils';

interface AppendChangeEventInput {
  noticeNum: number;
  eventType: ChangeEventType;
  eventHash: string;
  detectedAt?: Date;
  source?: NoticeChangeSource | null;
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
  source?: NoticeChangeSource | null;
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
  excludeLegacyGenesisSource?: boolean;
  comparableOnly?: boolean;
}

export interface ChangeTimelineItem {
  id: number;
  noticeNum: number;
  detectedAt: Date;
  eventType: ChangeEventType;
  source: NoticeChangeSource | null;
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
  source: NoticeChangeSource | null;
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

export interface ComparableChangeSummary {
  comparableEventTotal: number;
  comparableNoticeCount: number;
}

interface ChainVerificationIssue {
  noticeNum: number;
  eventId?: number;
  eventHeight?: number;
  code: string;
  message: string;
}

interface ChainVerificationReport {
  noticeNum: number;
  eventCount: number;
  latestEventHash: string | null;
  issues: ChainVerificationIssue[];
}

export interface ChangeChainAuditReport {
  checkedAt: string;
  scope: 'daily' | 'weekly';
  noticeCount: number;
  eventCount: number;
  failureCount: number;
  checkpointRootHash: string;
  failures: ChainVerificationIssue[];
}

@Injectable()
export class ChangeTrackingService {
  private readonly logger = new Logger(ChangeTrackingService.name);
  private readonly APPEND_EVENT_MAX_RETRIES = 3;
  private readonly LEGACY_GENESIS_SOURCE =
    NoticeChangeSource.BOOTSTRAP_LEGACY_SEED;
  private readonly NOTIFICATION_SUPPRESSED_SOURCE_PREFIXES = [
    NoticeChangeSourcePrefix.BOOTSTRAP,
  ];
  private readonly queuedChangeNotifications: ChangeNotificationPayload[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private isFlushingQueuedNotifications = false;
  private notificationCollectionDepth = 0;
  private notificationSuppressionDepth = 0;

  constructor(
    @InjectRepository(NoticeChangeEvent)
    private readonly changeEventRepository: Repository<NoticeChangeEvent>,
    @InjectRepository(NoticeChangeDetail)
    private readonly changeDetailRepository: Repository<NoticeChangeDetail>,
    @Optional()
    private readonly notificationBatchService?: NotificationBatchService,
    @Optional() private readonly discordBridge?: DiscordBridgeService,
  ) {}

  async getLastEventForNotice(
    noticeNum: number,
  ): Promise<NoticeChangeEvent | null> {
    return this.changeEventRepository.findOne({
      where: { noticeNum },
      order: { eventHeight: 'DESC' },
    });
  }

  async getNoticeNumsWithAnyEvent(noticeNums: number[]): Promise<Set<number>> {
    const uniqueNums = Array.from(new Set(noticeNums));
    if (uniqueNums.length === 0) {
      return new Set<number>();
    }

    const rows = await this.changeEventRepository
      .createQueryBuilder('event')
      .select('DISTINCT event.notice_num', 'noticeNum')
      .where('event.notice_num IN (:...noticeNums)', { noticeNums: uniqueNums })
      .getRawMany<{ noticeNum: number | string }>();

    return new Set(
      rows
        .map((row) => Number.parseInt(String(row.noticeNum), 10))
        .filter((value) => Number.isInteger(value) && value > 0),
    );
  }

  async getChangeEventCountsByNoticeNums(
    noticeNums: number[],
  ): Promise<Map<number, number>> {
    const uniqueNums = Array.from(
      new Set(
        noticeNums.filter((value) => Number.isInteger(value) && value > 0),
      ),
    );
    if (uniqueNums.length === 0) {
      return new Map<number, number>();
    }

    const rows = await this.changeEventRepository
      .createQueryBuilder('event')
      .select('event.notice_num', 'noticeNum')
      .addSelect('COUNT(*)', 'eventCount')
      .addSelect(
        `SUM(CASE WHEN event.source = :legacyGenesisSource THEN 1 ELSE 0 END)`,
        'legacyGenesisCount',
      )
      .where('event.notice_num IN (:...noticeNums)', { noticeNums: uniqueNums })
      .groupBy('event.notice_num')
      .having(
        `NOT (COUNT(*) = 1 AND SUM(CASE WHEN event.source = :legacyGenesisSource THEN 1 ELSE 0 END) = 1)`,
      )
      .setParameter('legacyGenesisSource', this.LEGACY_GENESIS_SOURCE)
      .getRawMany<{
        noticeNum: number | string;
        eventCount: number | string;
        legacyGenesisCount: number | string;
      }>();

    const countMap = new Map<number, number>();
    for (const row of rows) {
      const noticeNum = Number.parseInt(String(row.noticeNum), 10);
      const eventCount = Number.parseInt(String(row.eventCount), 10);
      const legacyGenesisCount = Number.parseInt(
        String(row.legacyGenesisCount),
        10,
      );

      if (
        Number.isInteger(noticeNum) &&
        noticeNum > 0 &&
        Number.isInteger(eventCount) &&
        eventCount >= 0 &&
        Number.isInteger(legacyGenesisCount) &&
        legacyGenesisCount >= 0
      ) {
        countMap.set(noticeNum, eventCount);
      }
    }

    return countMap;
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
    LoggerUtils.debugDev(
      ChangeTrackingService.name,
      `Appended change event notice=${saved.noticeNum} height=${saved.eventHeight} hash=${saved.eventHash}`,
    );
    void this.discordBridge?.logEvent(
      BridgeLogLevel.DEBUG,
      ChangeTrackingService.name,
      `Appended change event notice=${saved.noticeNum} height=${saved.eventHeight}`,
      {
        noticeNum: saved.noticeNum,
        eventHeight: saved.eventHeight,
        eventHash: saved.eventHash,
      },
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

        LoggerUtils.debugDev(
          ChangeTrackingService.name,
          `Appended change event notice=${saved.noticeNum} height=${saved.eventHeight} hash=${saved.eventHash}`,
        );
        void this.discordBridge?.logEvent(
          BridgeLogLevel.DEBUG,
          ChangeTrackingService.name,
          `Appended change event notice=${saved.noticeNum} height=${saved.eventHeight}`,
          {
            noticeNum: saved.noticeNum,
            eventHeight: saved.eventHeight,
            eventHash: saved.eventHash,
          },
        );
        return saved;
      } catch (error) {
        if (this.isEventHeightConflictError(error) && attempt < maxRetries) {
          this.logger.warn(
            `Change event append conflict for notice=${input.noticeNum}, retrying (${attempt}/${maxRetries})`,
          );
          void this.discordBridge?.logEvent(
            BridgeLogLevel.WARN,
            ChangeTrackingService.name,
            `Change event append conflict for notice=${input.noticeNum}, retrying (${attempt}/${maxRetries})`,
            {
              noticeNum: input.noticeNum,
              attempt,
              maxRetries,
            },
          );
          continue;
        }

        if (this.isSqliteTransactionStartConflictError(error)) {
          if (attempt < maxRetries) {
            this.logger.warn(
              `SQLite transaction start conflict for notice=${input.noticeNum}, retrying (${attempt}/${maxRetries})`,
            );
            void this.discordBridge?.logEvent(
              BridgeLogLevel.WARN,
              ChangeTrackingService.name,
              `SQLite transaction start conflict for notice=${input.noticeNum}, retrying (${attempt}/${maxRetries})`,
              {
                noticeNum: input.noticeNum,
                attempt,
                maxRetries,
              },
            );
            await this.delayBeforeRetry(attempt);
            continue;
          }
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

  private isSqliteTransactionStartConflictError(error: unknown): boolean {
    const message = String(
      (error as { message?: string } | undefined)?.message ?? '',
    ).toLowerCase();
    const code = String(
      (error as { code?: string } | undefined)?.code ?? '',
    ).toLowerCase();
    const driverError = (
      error as { driverError?: { message?: string; code?: string } } | undefined
    )?.driverError;
    const driverMessage = String(driverError?.message ?? '').toLowerCase();
    const driverCode = String(driverError?.code ?? '').toLowerCase();

    const targetMessage = 'cannot start a transaction within a transaction';

    return (
      message.includes(targetMessage) ||
      driverMessage.includes(targetMessage) ||
      (code === 'sqlite_error' && message.includes('begin transaction')) ||
      (driverCode === 'sqlite_error' &&
        (driverMessage.includes('begin transaction') ||
          driverMessage.includes(targetMessage)))
    );
  }

  private async delayBeforeRetry(attempt: number): Promise<void> {
    const delayMs = Math.min(10 * attempt, 50);
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
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

    if (this.isSuppressingChangeNotifications()) {
      LoggerUtils.debugDev(
        ChangeTrackingService.name,
        `Skipping change notification for notice ${input.event.noticeNum} because change notifications are suppressed`,
      );
      return;
    }

    if (input.event.eventType === 'created') {
      LoggerUtils.debugDev(
        ChangeTrackingService.name,
        `Skipping change notification for created notice ${input.event.noticeNum} because the regular notice notification already covers it`,
      );
      void this.discordBridge?.logEvent(
        BridgeLogLevel.DEBUG,
        ChangeTrackingService.name,
        `Skipped change notification for created notice **${input.event.noticeNum}**`,
        {
          noticeNum: input.event.noticeNum,
          eventHash: input.event.eventHash,
        },
      );
      return;
    }

    const normalizedSource = (input.event.source ?? '').toLowerCase();
    if (
      normalizedSource.length > 0 &&
      this.NOTIFICATION_SUPPRESSED_SOURCE_PREFIXES.some((prefix) =>
        normalizedSource.startsWith(prefix),
      )
    ) {
      LoggerUtils.debugDev(
        ChangeTrackingService.name,
        `Skipping change notification for notice ${input.event.noticeNum} because source is notification-suppressed (${input.event.source})`,
      );
      void this.discordBridge?.logEvent(
        BridgeLogLevel.DEBUG,
        ChangeTrackingService.name,
        `Skipped change notification for source-suppressed event (notice=${input.event.noticeNum}, source=${input.event.source})`,
      );
      return;
    }

    const payload: ChangeNotificationPayload = {
      noticeNum: input.event.noticeNum,
      subject: input.subject,
      eventType: input.event.eventType,
      source: input.event.source,
      changedFields: input.changedFields,
      eventHash: input.event.eventHash,
      eventHeight: input.event.eventHeight,
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

  beginChangeNotificationSuppression(): void {
    this.notificationSuppressionDepth += 1;
  }

  endChangeNotificationSuppression(): void {
    if (this.notificationSuppressionDepth === 0) {
      return;
    }

    this.notificationSuppressionDepth -= 1;
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
      this.queuedChangeNotifications.length === 0 ||
      this.isCollectingChangeNotifications()
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

      LoggerUtils.debugDev(
        ChangeTrackingService.name,
        `Change notification batch dispatched for ${payloads.length} event(s), job=${batchJobId}`,
      );
      void this.discordBridge?.logEvent(
        BridgeLogLevel.DEBUG,
        ChangeTrackingService.name,
        `Change notification batch dispatched for ${payloads.length} event(s)`,
        {
          payloadCount: payloads.length,
          batchJobId,
        },
      );
    } catch (error) {
      this.logger.warn(
        `Failed to dispatch queued change notifications (${payloads.length} event(s)): ${(error as Error).message}`,
      );
      void this.discordBridge?.logEvent(
        BridgeLogLevel.WARN,
        ChangeTrackingService.name,
        `Failed to dispatch queued change notifications (${payloads.length} event(s)): ${(error as Error).message}`,
        {
          payloadCount: payloads.length,
        },
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

  private isSuppressingChangeNotifications(): boolean {
    return this.notificationSuppressionDepth > 0;
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
    const builder = this.changeEventRepository
      .createQueryBuilder('event')
      .orderBy('event.detectedAt', 'DESC')
      .addOrderBy('event.id', 'DESC');

    if (query.eventType) {
      builder.andWhere('event.eventType = :eventType', {
        eventType: query.eventType,
      });
    }

    if (query.excludeLegacyGenesisSource) {
      builder.andWhere(
        '(event.source IS NULL OR event.source != :legacyGenesisSource)',
      );
      builder.setParameter('legacyGenesisSource', this.LEGACY_GENESIS_SOURCE);
    }

    if (query.comparableOnly) {
      const comparableNoticeSubQuery = this.changeEventRepository
        .createQueryBuilder('ce')
        .select('ce.noticeNum')
        .groupBy('ce.noticeNum')
        .having(
          '(COUNT(*) - SUM(CASE WHEN ce.source = :legacyGenesisSource THEN 1 ELSE 0 END)) >= 2',
        );

      builder
        .andWhere(`event.noticeNum IN (${comparableNoticeSubQuery.getQuery()})`)
        .setParameter('legacyGenesisSource', this.LEGACY_GENESIS_SOURCE);
    }

    builder.skip((page - 1) * limit).take(limit);

    const [items, total] = await builder.getManyAndCount();

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

  async getComparableChangeSummary(): Promise<ComparableChangeSummary> {
    const rows = await this.changeEventRepository
      .createQueryBuilder('event')
      .select('event.notice_num', 'noticeNum')
      .addSelect(
        '(COUNT(*) - SUM(CASE WHEN event.source = :legacyGenesisSource THEN 1 ELSE 0 END))',
        'comparableEventCount',
      )
      .groupBy('event.notice_num')
      .having(
        '(COUNT(*) - SUM(CASE WHEN event.source = :legacyGenesisSource THEN 1 ELSE 0 END)) >= 2',
      )
      .setParameter('legacyGenesisSource', this.LEGACY_GENESIS_SOURCE)
      .getRawMany<{
        noticeNum: number | string;
        comparableEventCount: number | string;
      }>();

    const comparableEventTotal = rows.reduce((sum, row) => {
      const value = Number.parseInt(String(row.comparableEventCount), 10);
      if (!Number.isInteger(value) || value <= 0) {
        return sum;
      }

      return sum + value;
    }, 0);

    return {
      comparableEventTotal,
      comparableNoticeCount: rows.length,
    };
  }

  async runScheduledChainAudit(
    scope: 'daily' | 'weekly',
  ): Promise<ChangeChainAuditReport> {
    const reports = await this.verifyAllChains();
    const failures = reports.flatMap((report) => report.issues);
    const checkpointRootHash = this.computeCheckpointRootHash(reports);
    const result: ChangeChainAuditReport = {
      checkedAt: new Date().toISOString(),
      scope,
      noticeCount: reports.length,
      eventCount: reports.reduce((sum, report) => sum + report.eventCount, 0),
      failureCount: failures.length,
      checkpointRootHash,
      failures,
    };

    const summaryMessage =
      `Change-chain ${scope} audit completed: ` +
      `${result.noticeCount} notice(s), ${result.eventCount} event(s), ` +
      `${result.failureCount} failure(s), checkpoint=${checkpointRootHash}`;

    if (result.failureCount > 0) {
      this.logger.error(summaryMessage);
      void this.discordBridge?.logEvent(
        BridgeLogLevel.ERROR,
        ChangeTrackingService.name,
        summaryMessage,
        {
          scope,
          checkpointRootHash,
          failures: failures.slice(0, 20),
        },
      );
    } else {
      this.logger.log(summaryMessage);
      void this.discordBridge?.logEvent(
        BridgeLogLevel.LOG,
        ChangeTrackingService.name,
        summaryMessage,
        {
          scope,
          checkpointRootHash,
          noticeCount: result.noticeCount,
          eventCount: result.eventCount,
        },
      );
    }

    return result;
  }

  private async verifyAllChains(): Promise<ChainVerificationReport[]> {
    const rawNoticeNums = await this.changeEventRepository
      .createQueryBuilder('event')
      .select('DISTINCT event.noticeNum', 'noticeNum')
      .orderBy('event.noticeNum', 'ASC')
      .getRawMany<{ noticeNum: number | string }>();

    const reports: ChainVerificationReport[] = [];
    for (const raw of rawNoticeNums) {
      reports.push(await this.verifyNoticeChain(Number(raw.noticeNum)));
    }

    return reports;
  }

  private async verifyNoticeChain(
    noticeNum: number,
  ): Promise<ChainVerificationReport> {
    const events = await this.changeEventRepository.find({
      where: { noticeNum },
      order: { eventHeight: 'ASC', id: 'ASC' },
    });
    const eventIds = events.map((event) => event.id);
    const details = eventIds.length
      ? await this.changeDetailRepository.find({
          where: { eventId: In(eventIds) },
          order: { id: 'ASC' },
        })
      : [];

    const detailsByEventId = new Map<number, NoticeChangeDetail[]>();
    for (const detail of details) {
      const bucket = detailsByEventId.get(detail.eventId) ?? [];
      bucket.push(detail);
      detailsByEventId.set(detail.eventId, bucket);
    }

    const issues: ChainVerificationIssue[] = [];
    let previousHash: string | null = null;
    let currentState = this.createEmptyTrackedState();

    events.forEach((event, index) => {
      const eventDetails = detailsByEventId.get(event.id) ?? [];
      const beforeState = index === 0 ? null : { ...currentState };
      const nextState = this.applyDetailsToTrackedState(
        currentState,
        eventDetails,
      );
      const rebuilt = this.buildDiffEvent({
        noticeNum,
        beforeSnapshot: beforeState,
        afterSnapshot: nextState,
        detectedAt: event.detectedAt,
        source: event.source,
        trackedFields: DEFAULT_TRACKED_FIELDS,
        hashAlgo: event.hashAlgo,
        canonVersion: event.canonVersion,
      });

      if (event.eventHeight !== index + 1) {
        issues.push({
          noticeNum,
          eventId: event.id,
          eventHeight: event.eventHeight,
          code: 'event_height_gap',
          message: `Expected event height ${index + 1} but found ${event.eventHeight}`,
        });
      }

      if ((event.prevEventHash ?? null) !== previousHash) {
        issues.push({
          noticeNum,
          eventId: event.id,
          eventHeight: event.eventHeight,
          code: 'prev_hash_mismatch',
          message: `Expected prev_event_hash ${previousHash ?? 'null'} but found ${event.prevEventHash ?? 'null'}`,
        });
      }

      if (event.eventHash !== rebuilt.eventHash) {
        issues.push({
          noticeNum,
          eventId: event.id,
          eventHeight: event.eventHeight,
          code: 'event_hash_mismatch',
          message:
            'Stored event hash does not match the reconstructed canonical event hash',
        });
      }

      if (event.eventType !== rebuilt.eventType) {
        issues.push({
          noticeNum,
          eventId: event.id,
          eventHeight: event.eventHeight,
          code: 'event_type_mismatch',
          message: `Expected event type ${rebuilt.eventType} but found ${event.eventType}`,
        });
      }

      if (event.changedFieldCount !== rebuilt.diff.changedFieldCount) {
        issues.push({
          noticeNum,
          eventId: event.id,
          eventHeight: event.eventHeight,
          code: 'changed_field_count_mismatch',
          message: `Expected changedFieldCount ${rebuilt.diff.changedFieldCount} but found ${event.changedFieldCount}`,
        });
      }

      if ((event.diffSummaryJson ?? null) !== rebuilt.diff.diffSummaryJson) {
        issues.push({
          noticeNum,
          eventId: event.id,
          eventHeight: event.eventHeight,
          code: 'diff_summary_mismatch',
          message:
            'Stored diff summary does not match the reconstructed diff summary',
        });
      }

      for (const detail of eventDetails) {
        const expectedBeforeHash = detail.beforeValue
          ? sha256Hex(detail.beforeValue)
          : null;
        const expectedAfterHash = detail.afterValue
          ? sha256Hex(detail.afterValue)
          : null;

        if ((detail.beforeHash ?? null) !== expectedBeforeHash) {
          issues.push({
            noticeNum,
            eventId: event.id,
            eventHeight: event.eventHeight,
            code: 'detail_before_hash_mismatch',
            message: `before_hash mismatch on field ${detail.fieldPath}`,
          });
        }

        if ((detail.afterHash ?? null) !== expectedAfterHash) {
          issues.push({
            noticeNum,
            eventId: event.id,
            eventHeight: event.eventHeight,
            code: 'detail_after_hash_mismatch',
            message: `after_hash mismatch on field ${detail.fieldPath}`,
          });
        }
      }

      currentState = nextState;
      previousHash = event.eventHash;
    });

    return {
      noticeNum,
      eventCount: events.length,
      latestEventHash: previousHash,
      issues,
    };
  }

  private createEmptyTrackedState(): Record<string, string | null> {
    return Object.fromEntries(
      DEFAULT_TRACKED_FIELDS.map((fieldPath) => [fieldPath, null]),
    ) as Record<string, string | null>;
  }

  private applyDetailsToTrackedState(
    previousState: Record<string, string | null>,
    details: NoticeChangeDetail[],
  ): Record<string, string | null> {
    const nextState = { ...previousState };

    for (const detail of details) {
      nextState[detail.fieldPath] = detail.afterValue ?? null;
    }

    return nextState;
  }

  private computeCheckpointRootHash(
    reports: ChainVerificationReport[],
  ): string {
    return sha256Hex(
      canonicalStringify(
        reports.map((report) => ({
          noticeNum: report.noticeNum,
          eventCount: report.eventCount,
          latestEventHash: report.latestEventHash,
          issueCount: report.issues.length,
        })),
      ),
    );
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
