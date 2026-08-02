import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { LoggerUtils } from '../../utils/logger.utils';
import { logAndBridge } from '../../utils/bridge-log.utils';
import { DatabaseDumpService } from './database-dump.service';
import { FileKiwiClientService } from './file-kiwi-client.service';
import { DiscordBridgeService } from '../discord-bridge/discord-bridge.service';

@Injectable()
export class DbMirrorService {
  private readonly logger = LoggerUtils.getContextLogger(DbMirrorService.name);

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly configService: ConfigService,
    private readonly databaseDumpService: DatabaseDumpService,
    private readonly fileKiwiClientService: FileKiwiClientService,
  ) {}

  async onModuleInit(): Promise<void> {
    const testUploadOnStartup =
      this.configService.get<boolean>(
        'fileMirror.testUploadOnStartup',
        false,
      ) ?? false;

    if (!testUploadOnStartup) {
      return;
    }

    logAndBridge({
      method: 'log',
      message:
        'FILE_MIRROR_TEST_UPLOAD_ON_STARTUP=true detected. Running one-shot DB mirror upload test.',
      logger: this.logger,
      context: DbMirrorService.name,
      discordBridge: this.resolveDiscordBridge(),
    });

    await this.runMirrorJob();
  }

  async runMirrorJob(options?: { force?: boolean }): Promise<void> {
    const force = options?.force ?? false;
    const enabled =
      this.configService.get<boolean>('fileMirror.enabled', false) ?? false;

    if (!enabled && !force) {
      logAndBridge({
        method: 'debug',
        message:
          'Database mirror is disabled (FILE_MIRROR_ENABLED=false), skipping.',
        logger: this.logger,
        context: DbMirrorService.name,
        discordBridge: this.resolveDiscordBridge(),
      });
      return;
    }

    if (!enabled && force) {
      logAndBridge({
        method: 'warn',
        message:
          'Database mirror is disabled, but a forced manual upload was requested. Running one-shot upload test anyway.',
        logger: this.logger,
        context: DbMirrorService.name,
        discordBridge: this.resolveDiscordBridge(),
      });
    }

    const titlePrefix =
      this.configService.get<string>('fileMirror.titlePrefix') ||
      'lawcast-db-mirror';
    const keepLocalDump =
      this.configService.get<boolean>('fileMirror.keepLocalDump', false) ??
      false;
    const mirrorAnnouncementChannelId =
      this.configService.get<string>('fileMirror.discordChannelId') || '';
    const discordBridge = this.resolveDiscordBridge();

    let dump: Awaited<
      ReturnType<DatabaseDumpService['createSanitizedDump']>
    > | null = null;

    try {
      try {
        dump = await this.databaseDumpService.createSanitizedDump();
      } catch (error) {
        await this.notifyMirrorFailure({
          stage: 'dump',
          error,
          mirrorAnnouncementChannelId,
          discordBridge,
        });
        throw error;
      }

      const upload = await this.fileKiwiClientService.uploadFile({
        filePath: dump.dumpPath,
        title: `${titlePrefix}-${dump.dumpFileName}`,
      });

      logAndBridge({
        method: 'log',
        message: `Database mirror uploaded successfully (folderId=${upload.folderId}, fileId=${upload.fileId}, shareUrl=${upload.shareUrl})`,
        logger: this.logger,
        context: DbMirrorService.name,
        discordBridge,
        bridgeMessage: `DB mirror uploaded: folder=${upload.folderId}, file=${upload.fileId}`,
        metadata: {
          folderId: upload.folderId,
          fileId: upload.fileId,
          shareUrl: upload.shareUrl,
        },
      });

      if (!mirrorAnnouncementChannelId) {
        logAndBridge({
          method: 'warn',
          message:
            'FILE_MIRROR_DISCORD_CHANNEL_ID is empty. Skipping cleanup of mirror error announcement messages.',
          logger: this.logger,
          context: DbMirrorService.name,
          discordBridge,
        });
      } else if (!discordBridge) {
        logAndBridge({
          method: 'warn',
          message:
            'DiscordBridgeService is unavailable. Skipping cleanup of mirror error announcement messages.',
          logger: this.logger,
          context: DbMirrorService.name,
        });
      } else {
        await discordBridge.clearDbMirrorErrorAnnouncements(
          mirrorAnnouncementChannelId,
        );
      }

      if (!mirrorAnnouncementChannelId) {
        logAndBridge({
          method: 'warn',
          message:
            'FILE_MIRROR_DISCORD_CHANNEL_ID is empty. Skipping mirror announcement embed update.',
          logger: this.logger,
          context: DbMirrorService.name,
          discordBridge,
        });
      } else if (!discordBridge) {
        logAndBridge({
          method: 'warn',
          message:
            'DiscordBridgeService is unavailable. Skipping mirror announcement embed update.',
          logger: this.logger,
          context: DbMirrorService.name,
        });
      } else {
        await discordBridge.upsertDbMirrorAnnouncement({
          channelId: mirrorAnnouncementChannelId,
          shareUrl: upload.shareUrl,
          dumpedAt: new Date(),
          dumpFileName: dump.dumpFileName,
          folderId: upload.folderId,
          fileId: upload.fileId,
        });
      }
    } catch (error) {
      // Upload phase failures should notify mirror channel as actionable incidents.
      if (dump) {
        await this.notifyMirrorFailure({
          stage: 'upload',
          error,
          mirrorAnnouncementChannelId,
          discordBridge,
          dumpFileName: dump.dumpFileName,
        });
      }
      throw error;
    } finally {
      if (!keepLocalDump && dump) {
        await this.databaseDumpService.removeDumpFile(dump.dumpPath);
      }
    }
  }

  private async notifyMirrorFailure(params: {
    stage: 'dump' | 'upload';
    error: unknown;
    mirrorAnnouncementChannelId: string;
    discordBridge?: DiscordBridgeService;
    dumpFileName?: string;
  }): Promise<void> {
    const message =
      params.error instanceof Error
        ? params.error.message
        : String(params.error);

    logAndBridge({
      method: 'error',
      message: `Database mirror ${params.stage} stage failed: ${message}`,
      logger: this.logger,
      context: DbMirrorService.name,
      discordBridge: params.discordBridge,
      metadata: {
        stage: params.stage,
        dumpFileName: params.dumpFileName,
      },
    });

    if (!params.mirrorAnnouncementChannelId) {
      logAndBridge({
        method: 'warn',
        message:
          'FILE_MIRROR_DISCORD_CHANNEL_ID is empty. Skipping mirror error announcement embed update.',
        logger: this.logger,
        context: DbMirrorService.name,
        discordBridge: params.discordBridge,
      });
      return;
    }

    if (!params.discordBridge) {
      logAndBridge({
        method: 'warn',
        message:
          'DiscordBridgeService is unavailable. Skipping mirror error announcement embed update.',
        logger: this.logger,
        context: DbMirrorService.name,
      });
      return;
    }

    await params.discordBridge.upsertDbMirrorErrorAnnouncement({
      channelId: params.mirrorAnnouncementChannelId,
      failedAt: new Date(),
      stage: params.stage,
      errorMessage: message,
      dumpFileName: params.dumpFileName,
    });
  }

  private resolveDiscordBridge(): DiscordBridgeService | undefined {
    return this.moduleRef.get(DiscordBridgeService, {
      strict: false,
    });
  }
}
