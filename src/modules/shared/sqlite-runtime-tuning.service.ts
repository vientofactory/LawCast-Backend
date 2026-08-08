import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { LoggerUtils } from '../../utils/logger.utils';

@Injectable()
export class SqliteRuntimeTuningService implements OnModuleInit {
  private readonly logger = LoggerUtils.getContextLogger(
    SqliteRuntimeTuningService.name,
  );

  constructor(
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    const type = String(this.dataSource.options.type ?? '').toLowerCase();
    if (type !== 'sqlite' && type !== 'better-sqlite3') {
      return;
    }

    const tuningEnabled = this.readBooleanEnv(
      'SQLITE_RUNTIME_TUNING_ENABLED',
      true,
    );
    if (!tuningEnabled) {
      return;
    }

    const cacheSizeKb = this.readNumberEnv('SQLITE_CACHE_SIZE_KB', 32768);
    const mmapSizeBytes = this.readNumberEnv(
      'SQLITE_MMAP_SIZE_BYTES',
      268435456,
    );
    const busyTimeoutMs = this.readNumberEnv('SQLITE_BUSY_TIMEOUT_MS', 5000);

    const pragmas: string[] = [
      'PRAGMA journal_mode = WAL;',
      'PRAGMA synchronous = NORMAL;',
      'PRAGMA temp_store = MEMORY;',
      `PRAGMA cache_size = -${Math.max(1024, cacheSizeKb)};`,
      `PRAGMA mmap_size = ${Math.max(0, mmapSizeBytes)};`,
      `PRAGMA busy_timeout = ${Math.max(0, busyTimeoutMs)};`,
      'PRAGMA wal_autocheckpoint = 1000;',
    ];

    for (const pragma of pragmas) {
      await this.dataSource.query(pragma);
    }

    const [journalModeResult, syncResult] = await Promise.all([
      this.dataSource.query('PRAGMA journal_mode;'),
      this.dataSource.query('PRAGMA synchronous;'),
    ]);

    const journalMode = String(
      journalModeResult?.[0]?.journal_mode ?? 'unknown',
    );
    const synchronous = Number(syncResult?.[0]?.synchronous ?? -1);

    this.logger.log(
      `SQLite runtime tuning applied (journal_mode=${journalMode}, synchronous=${synchronous}, cache_size_kb=${cacheSizeKb}, mmap_size_bytes=${mmapSizeBytes}, busy_timeout_ms=${busyTimeoutMs})`,
    );
  }

  private readNumberEnv(key: string, fallback: number): number {
    const raw = this.configService.get<string>(key);
    if (!raw) {
      return fallback;
    }

    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private readBooleanEnv(key: string, fallback: boolean): boolean {
    const raw = this.configService.get<string>(key);
    if (!raw) {
      return fallback;
    }

    const normalized = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
      return false;
    }

    return fallback;
  }
}
