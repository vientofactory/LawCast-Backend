import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import type { Repository } from 'typeorm';
import { NoticeArchive } from './notice-archive.entity';

export interface NoticeSitemapSnapshot {
  generatedAt: string;
  total: number;
  items: { num: number; archiveStartedAt: string | null }[];
}

const CACHE_KEY = 'sitemap:notices:v1';
const FRESH_MS = 60 * 60 * 1000;
const MAX_STALE_MS = 24 * FRESH_MS;

@Injectable()
export class NoticeSitemapService {
  private readonly logger = new Logger(NoticeSitemapService.name);
  private snapshot: NoticeSitemapSnapshot | null = null;
  private refreshAfter = 0;
  private pending: Promise<NoticeSitemapSnapshot> | null = null;

  constructor(
    @InjectRepository(NoticeArchive)
    private readonly repository: Repository<NoticeArchive>,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  async getSnapshot(): Promise<NoticeSitemapSnapshot> {
    if (this.snapshot && Date.now() < this.refreshAfter) return this.snapshot;
    if (this.pending) return this.pending;
    const pending = this.refresh();
    this.pending = pending;
    try {
      return await pending;
    } finally {
      if (this.pending === pending) this.pending = null;
    }
  }

  private isUsable(
    value: NoticeSitemapSnapshot | undefined,
  ): value is NoticeSitemapSnapshot {
    return (
      !!value &&
      Number.isFinite(Date.parse(value.generatedAt)) &&
      Date.parse(value.generatedAt) <= Date.now() &&
      Date.now() - Date.parse(value.generatedAt) < MAX_STALE_MS &&
      Array.isArray(value.items) &&
      value.total === value.items.length &&
      value.items.every(
        (item, index) =>
          Number.isSafeInteger(item.num) &&
          item.num > 0 &&
          (index === 0 || item.num > value.items[index - 1].num) &&
          (item.archiveStartedAt === null ||
            Number.isFinite(Date.parse(item.archiveStartedAt))),
      )
    );
  }

  private async refresh(): Promise<NoticeSitemapSnapshot> {
    try {
      const stored = await this.cache.get<NoticeSitemapSnapshot>(CACHE_KEY);
      if (
        this.isUsable(stored) &&
        (!this.snapshot || stored.generatedAt > this.snapshot.generatedAt)
      ) {
        this.snapshot = stored;
      }
    } catch (err) {
      this.logger.warn('Sitemap snapshot cache read failed', err);
    }
    if (
      this.snapshot &&
      Date.now() - Date.parse(this.snapshot.generatedAt) < FRESH_MS
    ) {
      this.refreshAfter = Date.parse(this.snapshot.generatedAt) + FRESH_MS;
      return this.snapshot;
    }
    try {
      // One consistent, metadata-only read replaces hundreds of interactive API calls.
      const rows = await this.repository.find({
        select: { noticeNum: true, archiveStartedAt: true },
        order: { noticeNum: 'ASC' },
      });
      const snapshot: NoticeSitemapSnapshot = {
        generatedAt: new Date().toISOString(),
        total: rows.length,
        items: rows.map((row) => ({
          num: row.noticeNum,
          archiveStartedAt:
            row.archiveStartedAt &&
            Number.isFinite(new Date(row.archiveStartedAt).getTime())
              ? new Date(row.archiveStartedAt).toISOString()
              : null,
        })),
      };
      if (!this.isUsable(snapshot)) throw new Error('Invalid sitemap snapshot');
      // Redis replaces the complete value atomically and retains the last good generation.
      try {
        await this.cache.set(CACHE_KEY, snapshot, 0);
      } catch (err) {
        this.logger.warn('Sitemap snapshot cache write failed', err);
      }
      this.snapshot = snapshot;
      this.refreshAfter = Date.now() + FRESH_MS;
      return snapshot;
    } catch (err) {
      this.logger.error('Sitemap snapshot generation failed', err);
      if (this.isUsable(this.snapshot)) {
        this.refreshAfter = Math.min(
          Date.now() + 60_000,
          Date.parse(this.snapshot.generatedAt) + MAX_STALE_MS,
        );
        return this.snapshot;
      }
      throw new ServiceUnavailableException(
        '사이트맵을 생성하지 못했습니다. 잠시 후 다시 시도해주세요.',
      );
    }
  }
}
