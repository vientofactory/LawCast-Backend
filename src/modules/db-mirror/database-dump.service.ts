import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ConfigService } from '@nestjs/config';
import { LoggerUtils } from '../../utils/logger.utils';
import { logAndBridge } from '../../utils/bridge-log.utils';
import { DiscordBridgeService } from '../discord-bridge/discord-bridge.service';
import { logMirrorMetric, measureMirrorPhase } from './mirror-phase-metrics';
import { superviseDumpChild } from './dump-child-supervisor';

const DEFAULT_DUMP_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_TIMER_MS = 2_147_483_647;

export interface DatabaseDumpArtifact {
  dumpPath: string;
  dumpFileName: string;
  fileSizeBytes: number;
  retainedTables: string[];
}

@Injectable()
export class DatabaseDumpService implements OnModuleDestroy {
  private readonly logger = LoggerUtils.getContextLogger(
    DatabaseDumpService.name,
  );
  private activeDump?: {
    controller: AbortController;
    work: Promise<DatabaseDumpArtifact>;
  };
  private shuttingDown = false;

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {}

  async createSanitizedDump(): Promise<DatabaseDumpArtifact> {
    if (this.shuttingDown)
      throw new Error('Database dump service is shutting down');
    if (this.activeDump) throw new Error('Database dump is already running');

    const controller = new AbortController();
    const work = this.buildDump(controller.signal).finally(() => {
      this.activeDump = undefined;
    });
    this.activeDump = { controller, work };
    return work;
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    const active = this.activeDump;
    if (!active) return;
    active.controller.abort();
    await Promise.allSettled([active.work]);
  }

  private async buildDump(signal: AbortSignal): Promise<DatabaseDumpArtifact> {
    const dumpDir =
      this.configService.get<string>('fileMirror.dumpDir') ||
      path.resolve(process.cwd(), 'tmp', 'db-mirror');

    await fs.mkdir(dumpDir, { recursive: true });

    const timestamp = this.getTimestamp();
    const dumpFileName = `lawcast-mirror-${timestamp}.sqlite`;
    const dumpPath = path.resolve(dumpDir, dumpFileName);

    const { database } = this.dataSource.options;
    if (typeof database !== 'string' || !database || database === ':memory:') {
      throw new Error('Database dump requires a file-backed SQLite database');
    }

    // Reserve the output atomically so failure cleanup never removes another job's file.
    const reservation = await fs.open(dumpPath, 'wx', 0o600);
    let retainedTables: string[];
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      await reservation.close();
      retainedTables = await measureMirrorPhase(dumpFileName, 'dump_wait', () =>
        this.runDumpChild(
          path.resolve(database),
          dumpPath,
          dumpFileName,
          signal,
        ),
      );
      signal.throwIfAborted();
      stat = await fs.lstat(dumpPath);
      signal.throwIfAborted();
      if (!stat.isFile() || stat.size === 0) {
        throw new Error('Database dump child did not produce a usable file');
      }
    } catch (error) {
      for (const suffix of ['', '-journal', '-wal', '-shm']) {
        await this.removeDumpFile(dumpPath + suffix);
      }
      throw error;
    }

    logAndBridge({
      method: 'log',
      message: `Created sanitized SQLite dump (${dumpFileName}, ${stat.size} bytes, tables=${retainedTables.join(', ')})`,
      logger: this.logger,
      context: DatabaseDumpService.name,
      discordBridge: this.resolveDiscordBridge(),
      bridgeMessage: `DB dump created: ${dumpFileName} (${stat.size} bytes)`,
      metadata: {
        dumpFileName,
        sizeBytes: stat.size,
        retainedTables,
      },
    });

    return {
      dumpPath,
      dumpFileName,
      fileSizeBytes: stat.size,
      retainedTables,
    };
  }

  async removeDumpFile(dumpPath: string): Promise<void> {
    try {
      await fs.rm(dumpPath, { force: true });
    } catch (error) {
      logAndBridge({
        method: 'warn',
        message: `Failed to remove local dump file (${dumpPath}): ${(error as Error).message}`,
        logger: this.logger,
        context: DatabaseDumpService.name,
        discordBridge: this.resolveDiscordBridge(),
      });
    }
  }

  private resolveDiscordBridge(): DiscordBridgeService | undefined {
    try {
      return this.moduleRef.get(DiscordBridgeService, {
        strict: false,
      });
    } catch {
      return undefined;
    }
  }

  private runDumpChild(
    sourcePath: string,
    dumpPath: string,
    dumpFileName: string,
    signal: AbortSignal,
  ): Promise<string[]> {
    const configured = Number.parseInt(
      this.configService.get<string>('SQLITE_BUSY_TIMEOUT_MS') ?? '',
      10,
    );
    const busyTimeoutMs = Number.isFinite(configured)
      ? Math.min(MAX_TIMER_MS, Math.max(0, configured))
      : 5000;
    const requestedTimeout = Number(
      this.configService.get<string>('FILE_MIRROR_DUMP_TIMEOUT_MS'),
    );
    const timeoutMs =
      Number.isSafeInteger(requestedTimeout) && requestedTimeout > 0
        ? Math.min(MAX_TIMER_MS, requestedTimeout)
        : DEFAULT_DUMP_TIMEOUT_MS;
    return superviseDumpChild({
      entrypoint: path.join(__dirname, 'database-dump-child.cjs'),
      sourcePath,
      dumpPath,
      dumpFileName,
      busyTimeoutMs,
      timeoutMs,
      signal,
      onMetric: logMirrorMetric,
    });
  }

  private getTimestamp(): string {
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const hh = String(now.getUTCHours()).padStart(2, '0');
    const min = String(now.getUTCMinutes()).padStart(2, '0');
    const sec = String(now.getUTCSeconds()).padStart(2, '0');
    return `${yyyy}${mm}${dd}-${hh}${min}${sec}Z`;
  }
}
