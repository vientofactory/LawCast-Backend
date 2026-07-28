import { Injectable, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ConfigService } from '@nestjs/config';
import { LoggerUtils } from '../../utils/logger.utils';
import { logAndBridge } from '../../utils/bridge-log.utils';
import { DiscordBridgeService } from '../discord-bridge/discord-bridge.service';

export interface DatabaseDumpArtifact {
  dumpPath: string;
  dumpFileName: string;
  fileSizeBytes: number;
  retainedTables: string[];
}

@Injectable()
export class DatabaseDumpService {
  private readonly logger = LoggerUtils.getContextLogger(
    DatabaseDumpService.name,
  );
  private readonly legalDataTables = [
    'notice_archives',
    'notice_archive_snapshot_states',
    'notice_archive_integrity_checks',
    'notice_archive_integrity_states',
    'notice_change_events',
    'notice_change_details',
  ];

  constructor(
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
    @Optional() private readonly discordBridge?: DiscordBridgeService,
  ) {}

  async createSanitizedDump(): Promise<DatabaseDumpArtifact> {
    const dumpDir =
      this.configService.get<string>('fileMirror.dumpDir') ||
      path.resolve(process.cwd(), 'tmp', 'db-mirror');

    await fs.mkdir(dumpDir, { recursive: true });

    const timestamp = this.getTimestamp();
    const dumpFileName = `lawcast-mirror-${timestamp}.sqlite`;
    const dumpPath = path.join(dumpDir, dumpFileName);

    await this.copyDatabaseFile(dumpPath);
    const retainedTables = await this.pruneNonLegalTables(dumpPath);

    const stat = await fs.stat(dumpPath);

    logAndBridge({
      method: 'log',
      message: `Created sanitized SQLite dump (${dumpFileName}, ${stat.size} bytes, tables=${retainedTables.join(', ')})`,
      logger: this.logger,
      context: DatabaseDumpService.name,
      discordBridge: this.discordBridge,
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
        discordBridge: this.discordBridge,
      });
    }
  }

  private async copyDatabaseFile(dumpPath: string): Promise<void> {
    const escapedDumpPath = this.escapeSqliteStringLiteral(dumpPath);
    await this.dataSource.query(`VACUUM INTO '${escapedDumpPath}';`);
  }

  private async pruneNonLegalTables(dumpPath: string): Promise<string[]> {
    const dumpDataSource = new DataSource({
      type: 'sqlite',
      database: dumpPath,
      entities: [],
      synchronize: false,
    });

    await dumpDataSource.initialize();
    try {
      await dumpDataSource.query('PRAGMA foreign_keys = OFF;');

      const rows = (await dumpDataSource.query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%';",
      )) as Array<{ name?: string }>;

      const existingTableNames = rows
        .map((row) => row.name)
        .filter((name): name is string => typeof name === 'string');

      const legalTableSet = new Set(this.legalDataTables);
      const dropTargets = existingTableNames.filter(
        (tableName) => !legalTableSet.has(tableName),
      );

      for (const tableName of dropTargets) {
        await dumpDataSource.query(
          `DROP TABLE IF EXISTS ${this.escapeIdentifier(tableName)};`,
        );
      }

      await dumpDataSource.query('VACUUM;');
      return existingTableNames.filter((tableName) =>
        legalTableSet.has(tableName),
      );
    } finally {
      await dumpDataSource.destroy();
    }
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

  private escapeSqliteStringLiteral(value: string): string {
    return value.replace(/'/g, "''");
  }

  private escapeIdentifier(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
  }
}
