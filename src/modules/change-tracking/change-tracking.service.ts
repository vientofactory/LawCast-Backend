import { Injectable, Optional } from '@nestjs/common';
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
import { NoticeArchive } from '../notice/notice-archive.entity';
import {
  canonicalStringify,
  computeDiff,
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
import { runScheduledChainAuditInternal } from './change-tracking-chain-audit.utils';
import { delayMs } from '../../utils/async-delay.utils';
import { logAndBridge } from '../../utils/bridge-log.utils';
import { isUniqueConstraintConflictError } from '../../utils/db-error.utils';

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
  preferredEventType?: ChangeEventType;
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
  fromEventId?: number;
  toEventId?: number;
  fromDetectedAt?: Date;
  toDetectedAt?: Date;
  anchorEventId?: number;
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
  subject: string | null;
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
  anchorPage?: number | null;
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
  private readonly logger = LoggerUtils.getContextLogger(
    ChangeTrackingService.name,
  );
  private readonly APPEND_EVENT_MAX_RETRIES = 3;
  private readonly BASELINE_EVENT_HEIGHT = 1;
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
    @InjectRepository(NoticeArchive)
    private readonly noticeArchiveRepository?: Repository<NoticeArchive>,
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
        `SUM(CASE WHEN event.event_height = :baselineEventHeight THEN 1 ELSE 0 END)`,
        'baselineCount',
      )
      .where('event.notice_num IN (:...noticeNums)', { noticeNums: uniqueNums })
      .groupBy('event.notice_num')
      .having(
        `NOT (COUNT(*) = 1 AND SUM(CASE WHEN event.event_height = :baselineEventHeight THEN 1 ELSE 0 END) = 1)`,
      )
      .setParameter('baselineEventHeight', this.BASELINE_EVENT_HEIGHT)
      .getRawMany<{
        noticeNum: number | string;
        eventCount: number | string;
        baselineCount: number | string;
      }>();

    const countMap = new Map<number, number>();
    for (const row of rows) {
      const noticeNum = Number.parseInt(String(row.noticeNum), 10);
      const eventCount = Number.parseInt(String(row.eventCount), 10);
      const baselineCount = Number.parseInt(String(row.baselineCount), 10);

      if (
        Number.isInteger(noticeNum) &&
        noticeNum > 0 &&
        Number.isInteger(eventCount) &&
        eventCount >= 0 &&
        Number.isInteger(baselineCount) &&
        baselineCount >= 0
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

    const event = this.createChangeEventEntity(
      this.changeEventRepository,
      input,
      lastEvent,
    );

    const saved = await this.changeEventRepository.save(event);
    return saved;
  }

  async appendChangeDetails(
    eventId: number,
    details: ChangeDetailInput[],
  ): Promise<void> {
    if (details.length === 0) return;

    const rows = this.createChangeDetailRows(
      this.changeDetailRepository,
      eventId,
      details,
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

    const duplicated = await this.findLatestDuplicateEvent(input, details);
    if (duplicated) {
      return duplicated;
    }

    const maxRetries = Math.max(
      input.maxRetries ?? this.APPEND_EVENT_MAX_RETRIES,
      1,
    );
    const shouldEmitPerEventAppendDebug = this.shouldEmitPerEventAppendDebug(
      input.source,
    );

    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      try {
        const saved = await this.changeEventRepository.manager.transaction(
          async (manager) =>
            this.appendEventAndDetailsInTransaction(manager, input, details),
        );

        if (shouldEmitPerEventAppendDebug) {
          logAndBridge({
            logger: {
              debug: (message: string) =>
                LoggerUtils.debugDev(ChangeTrackingService.name, message),
            },
            method: 'debug',
            message: `Appended change event notice=${saved.noticeNum} height=${saved.eventHeight} hash=${saved.eventHash}`,
            context: ChangeTrackingService.name,
            discordBridge: this.discordBridge,
            bridgeLevel: BridgeLogLevel.DEBUG,
            bridgeMessage: `Appended change event notice=${saved.noticeNum} height=${saved.eventHeight}`,
            metadata: {
              noticeNum: saved.noticeNum,
              eventHeight: saved.eventHeight,
              eventHash: saved.eventHash,
            },
          });
        }
        return saved;
      } catch (error) {
        if (this.isEventHashConflictError(error)) {
          const existing = await this.changeEventRepository.findOne({
            where: { eventHash: input.eventHash },
          });
          if (existing) {
            return existing;
          }
        }

        if (this.isEventHeightConflictError(error) && attempt < maxRetries) {
          const conflictMessage = `Change event append conflict for notice=${input.noticeNum}, retrying (${attempt}/${maxRetries})`;
          logAndBridge({
            logger: this.logger,
            method: 'warn',
            message: conflictMessage,
            context: ChangeTrackingService.name,
            discordBridge: this.discordBridge,
            metadata: {
              noticeNum: input.noticeNum,
              attempt,
              maxRetries,
            },
          });
          continue;
        }

        if (this.isSqliteTransactionStartConflictError(error)) {
          if (attempt < maxRetries) {
            const sqliteConflictMessage = `SQLite transaction start conflict for notice=${input.noticeNum}, retrying (${attempt}/${maxRetries})`;
            logAndBridge({
              logger: this.logger,
              method: 'warn',
              message: sqliteConflictMessage,
              context: ChangeTrackingService.name,
              discordBridge: this.discordBridge,
              metadata: {
                noticeNum: input.noticeNum,
                attempt,
                maxRetries,
              },
            });
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

  private async findLatestDuplicateEvent(
    input: AppendChangeEventWithDetailsInput,
    details: ChangeDetailInput[],
  ): Promise<NoticeChangeEvent | null> {
    const latest = await this.getLastEventForNotice(input.noticeNum);
    if (!latest) {
      return null;
    }

    if (latest.eventType !== input.eventType) {
      return null;
    }

    if ((latest.source ?? null) !== (input.source ?? null)) {
      return null;
    }

    if (latest.changedFieldCount !== (input.changedFieldCount ?? 0)) {
      return null;
    }

    if ((latest.diffSummaryJson ?? null) !== (input.diffSummaryJson ?? null)) {
      return null;
    }

    const latestDetails = await this.changeDetailRepository.find({
      where: { eventId: latest.id },
      order: { id: 'ASC' },
    });

    if (latestDetails.length !== details.length) {
      return null;
    }

    for (let index = 0; index < details.length; index += 1) {
      const incoming = details[index];
      const existing = latestDetails[index];

      if (
        existing.fieldPath !== incoming.fieldPath ||
        existing.changeType !== incoming.changeType ||
        (existing.beforeValue ?? null) !== (incoming.beforeValue ?? null) ||
        (existing.afterValue ?? null) !== (incoming.afterValue ?? null) ||
        (existing.beforeHash ?? null) !== (incoming.beforeHash ?? null) ||
        (existing.afterHash ?? null) !== (incoming.afterHash ?? null)
      ) {
        return null;
      }
    }

    return latest;
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

    const event = this.createChangeEventEntity(eventRepo, input, lastEvent);

    const saved = await eventRepo.save(event);

    if (details.length > 0) {
      const rows = this.createChangeDetailRows(detailRepo, saved.id, details);

      await detailRepo.save(rows);
    }

    return saved;
  }

  private createChangeEventEntity(
    repository: Repository<NoticeChangeEvent>,
    input: AppendChangeEventInput,
    lastEvent: NoticeChangeEvent | null,
  ): NoticeChangeEvent {
    return repository.create({
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
  }

  private createChangeDetailRows(
    repository: Repository<NoticeChangeDetail>,
    eventId: number,
    details: ChangeDetailInput[],
  ): NoticeChangeDetail[] {
    return details.map((detail) =>
      repository.create({
        eventId,
        fieldPath: detail.fieldPath,
        changeType: detail.changeType,
        beforeValue: detail.beforeValue ?? null,
        afterValue: detail.afterValue ?? null,
        beforeHash: detail.beforeHash ?? null,
        afterHash: detail.afterHash ?? null,
      }),
    );
  }

  private isEventHeightConflictError(error: unknown): boolean {
    return isUniqueConstraintConflictError(error, [
      'idx_notice_change_events_notice_num_event_height_unique',
      'notice_change_events.notice_num, notice_change_events.event_height',
      'notice_num_event_height',
    ]);
  }

  private isEventHashConflictError(error: unknown): boolean {
    return isUniqueConstraintConflictError(error, [
      'idx_notice_change_events_event_hash_unique',
      'notice_change_events.event_hash',
      'event_hash',
    ]);
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
    const waitMs = Math.min(10 * attempt, 50);
    await delayMs(waitMs);
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

    const eventType = this.resolveEventType(input);

    // For non-created events, append only when tracked fields changed.
    const shouldAppend = eventType === 'created' || diff.changed;

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

  private resolveEventType(input: BuildDiffEventInput): ChangeEventType {
    if (input.beforeSnapshot === null) {
      return 'created';
    }

    if (input.preferredEventType) {
      return input.preferredEventType;
    }

    const lifecycleStatus =
      typeof input.afterSnapshot.lifecycleStatus === 'string'
        ? input.afterSnapshot.lifecycleStatus.trim().toLowerCase()
        : '';
    const sourceDeletedAt = input.afterSnapshot.sourceDeletedAt;
    const hasSourceDeletedAt =
      sourceDeletedAt !== null &&
      sourceDeletedAt !== undefined &&
      String(sourceDeletedAt).trim().length > 0;

    if (
      lifecycleStatus === 'source_deleted' ||
      lifecycleStatus === 'renumbered' ||
      lifecycleStatus === 'invalidated' ||
      hasSourceDeletedAt
    ) {
      return 'invalidated';
    }

    return 'updated';
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
      // LoggerUtils.debugDev(
      //   ChangeTrackingService.name,
      //   `Skipping change notification for notice ${input.event.noticeNum} because change notifications are suppressed`,
      // );
      return;
    }

    if (input.event.eventType === 'created') {
      logAndBridge({
        logger: {
          debug: (message: string) =>
            LoggerUtils.debugDev(ChangeTrackingService.name, message),
        },
        method: 'debug',
        message: `Skipping change notification for created notice ${input.event.noticeNum} because the regular notice notification already covers it`,
        context: ChangeTrackingService.name,
        discordBridge: this.discordBridge,
        bridgeLevel: BridgeLogLevel.DEBUG,
        bridgeMessage: `Skipped change notification for created notice **${input.event.noticeNum}**`,
        metadata: {
          noticeNum: input.event.noticeNum,
          eventHash: input.event.eventHash,
        },
      });
      return;
    }

    const normalizedSource = (input.event.source ?? '').toLowerCase();
    if (
      normalizedSource.length > 0 &&
      this.NOTIFICATION_SUPPRESSED_SOURCE_PREFIXES.some((prefix) =>
        normalizedSource.startsWith(prefix),
      )
    ) {
      // LoggerUtils.debugDev(
      //   ChangeTrackingService.name,
      //   `Skipping change notification for notice ${input.event.noticeNum} because source is notification-suppressed (${input.event.source})`,
      // );
      // void this.discordBridge?.logEvent(
      //   BridgeLogLevel.DEBUG,
      //   ChangeTrackingService.name,
      //   `Skipped change notification for source-suppressed event (notice=${input.event.noticeNum}, source=${input.event.source})`,
      // );
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
      eventId: input.event.id,
      detectedAt: input.event.detectedAt.toISOString(),
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

      logAndBridge({
        logger: {
          debug: (message: string) =>
            LoggerUtils.debugDev(ChangeTrackingService.name, message),
        },
        method: 'debug',
        message: `Change notification batch dispatched for ${payloads.length} event(s), job=${batchJobId}`,
        context: ChangeTrackingService.name,
        discordBridge: this.discordBridge,
        bridgeLevel: BridgeLogLevel.DEBUG,
        bridgeMessage: `Change notification batch dispatched for ${payloads.length} event(s)`,
        metadata: {
          payloadCount: payloads.length,
          batchJobId,
        },
      });
    } catch (error) {
      const warnMessage = `Failed to dispatch queued change notifications (${payloads.length} event(s)): ${(error as Error).message}`;
      logAndBridge({
        logger: this.logger,
        method: 'warn',
        message: warnMessage,
        context: ChangeTrackingService.name,
        discordBridge: this.discordBridge,
        metadata: {
          payloadCount: payloads.length,
        },
      });
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

  private shouldEmitPerEventAppendDebug(
    source?: NoticeChangeSource | null,
  ): boolean {
    const normalizedSource = (source ?? '').toLowerCase();
    if (!normalizedSource) {
      return true;
    }

    return !this.NOTIFICATION_SUPPRESSED_SOURCE_PREFIXES.some((prefix) =>
      normalizedSource.startsWith(prefix),
    );
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

  async getLatestFieldAfterValue(
    noticeNum: number,
    fieldPath: string,
  ): Promise<string | null> {
    const row = await this.changeDetailRepository
      .createQueryBuilder('detail')
      .innerJoin(NoticeChangeEvent, 'event', 'event.id = detail.event_id')
      .select('detail.after_value', 'afterValue')
      .where('event.notice_num = :noticeNum', { noticeNum })
      .andWhere('detail.field_path = :fieldPath', { fieldPath })
      .andWhere(
        "detail.after_value IS NOT NULL AND TRIM(detail.after_value) != ''",
      )
      .orderBy('event.detected_at', 'DESC')
      .addOrderBy('event.event_height', 'DESC')
      .addOrderBy('detail.id', 'DESC')
      .limit(1)
      .getRawOne<{ afterValue: string | null }>();

    const value = row?.afterValue?.trim();
    return value ? value : null;
  }

  async getRecentChanges(
    query: RecentChangesQuery,
  ): Promise<RecentChangesResult> {
    const page = Math.max(query.page, 1);
    const limit = Math.min(Math.max(query.limit, 1), 100);
    const baseQueryBuilder =
      this.changeEventRepository.createQueryBuilder('event');

    // This API is for post-genesis change browsing only.
    baseQueryBuilder.andWhere('event.eventType != :createdEventType', {
      createdEventType: 'created',
    });

    if (query.eventType) {
      baseQueryBuilder.andWhere('event.eventType = :eventType', {
        eventType: query.eventType,
      });
    }

    if (query.excludeLegacyGenesisSource) {
      baseQueryBuilder.andWhere(
        '(event.source IS NULL OR event.source != :legacyGenesisSource)',
      );
      baseQueryBuilder.setParameter(
        'legacyGenesisSource',
        this.LEGACY_GENESIS_SOURCE,
      );
    }

    if (query.comparableOnly) {
      baseQueryBuilder.andWhere('event.eventHeight > :baselineEventHeight', {
        baselineEventHeight: this.BASELINE_EVENT_HEIGHT,
      });

      const comparableNoticeSubQuery = this.changeEventRepository
        .createQueryBuilder('ce')
        .select('ce.noticeNum')
        .groupBy('ce.noticeNum')
        .having(
          '(COUNT(*) - SUM(CASE WHEN ce.eventHeight = :baselineEventHeight THEN 1 ELSE 0 END)) >= 1',
        );

      baseQueryBuilder
        .andWhere(`event.noticeNum IN (${comparableNoticeSubQuery.getQuery()})`)
        .setParameter('baselineEventHeight', this.BASELINE_EVENT_HEIGHT);
    }

    if (query.fromEventId) {
      baseQueryBuilder.andWhere('event.id >= :fromEventId', {
        fromEventId: query.fromEventId,
      });
    }

    if (query.toEventId) {
      baseQueryBuilder.andWhere('event.id <= :toEventId', {
        toEventId: query.toEventId,
      });
    }

    if (query.fromDetectedAt) {
      baseQueryBuilder.andWhere('event.detectedAt >= :fromDetectedAt', {
        fromDetectedAt: query.fromDetectedAt,
      });
    }

    if (query.toDetectedAt) {
      baseQueryBuilder.andWhere('event.detectedAt <= :toDetectedAt', {
        toDetectedAt: query.toDetectedAt,
      });
    }

    let anchorPage: number | null = null;
    if (query.anchorEventId && query.anchorEventId > 0) {
      const anchorEvent = await baseQueryBuilder
        .clone()
        .andWhere('event.id = :anchorEventId', {
          anchorEventId: query.anchorEventId,
        })
        .getOne();

      if (anchorEvent) {
        const precedingCount = await baseQueryBuilder
          .clone()
          .andWhere(
            '(event.detectedAt > :anchorDetectedAt OR (event.detectedAt = :anchorDetectedAt AND event.id > :anchorEventId))',
            {
              anchorDetectedAt: anchorEvent.detectedAt,
              anchorEventId: anchorEvent.id,
            },
          )
          .getCount();

        anchorPage = Math.floor(precedingCount / limit) + 1;
      }
    }

    const builder = baseQueryBuilder
      .clone()
      .orderBy('event.detectedAt', 'DESC')
      .addOrderBy('event.id', 'DESC');

    builder.skip((page - 1) * limit).take(limit);

    const [items, total] = await builder.getManyAndCount();

    const noticeNumToSubject = new Map<number, string>();
    if (this.noticeArchiveRepository && items.length > 0) {
      const uniqueNoticeNums = Array.from(
        new Set(items.map((item) => item.noticeNum)),
      );
      const archives = await this.noticeArchiveRepository.find({
        where: { noticeNum: In(uniqueNoticeNums) },
        select: { noticeNum: true, subject: true },
      });

      for (const archive of archives) {
        noticeNumToSubject.set(archive.noticeNum, archive.subject);
      }
    }

    return {
      items: items.map((item) => ({
        id: item.id,
        noticeNum: item.noticeNum,
        subject: noticeNumToSubject.get(item.noticeNum) ?? null,
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
      anchorPage,
    };
  }

  async getComparableChangeSummary(): Promise<ComparableChangeSummary> {
    const rows = await this.changeEventRepository
      .createQueryBuilder('event')
      .select('event.notice_num', 'noticeNum')
      .addSelect(
        '(COUNT(*) - SUM(CASE WHEN event.event_height = :baselineEventHeight THEN 1 ELSE 0 END))',
        'comparableEventCount',
      )
      .groupBy('event.notice_num')
      .having(
        '(COUNT(*) - SUM(CASE WHEN event.event_height = :baselineEventHeight THEN 1 ELSE 0 END)) >= 1',
      )
      .setParameter('baselineEventHeight', this.BASELINE_EVENT_HEIGHT)
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
    return runScheduledChainAuditInternal(
      {
        changeEventRepository: this.changeEventRepository,
        changeDetailRepository: this.changeDetailRepository,
        baselineEventHeight: this.BASELINE_EVENT_HEIGHT,
        logger: this.logger,
        buildDiffEvent: (input) => this.buildDiffEvent(input),
        discordBridge: this.discordBridge,
      },
      scope,
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
