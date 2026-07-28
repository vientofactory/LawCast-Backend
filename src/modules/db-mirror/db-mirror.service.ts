import { Injectable, Optional } from '@nestjs/common';
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
    private readonly configService: ConfigService,
    private readonly databaseDumpService: DatabaseDumpService,
    private readonly fileKiwiClientService: FileKiwiClientService,
    @Optional() private readonly discordBridge?: DiscordBridgeService,
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
      discordBridge: this.discordBridge,
    });

    await this.runMirrorJob();
  }

  async runMirrorJob(): Promise<void> {
    const enabled =
      this.configService.get<boolean>('fileMirror.enabled', false) ?? false;
    if (!enabled) {
      logAndBridge({
        method: 'debug',
        message:
          'Database mirror is disabled (FILE_MIRROR_ENABLED=false), skipping.',
        logger: this.logger,
        context: DbMirrorService.name,
        discordBridge: this.discordBridge,
      });
      return;
    }

    const titlePrefix =
      this.configService.get<string>('fileMirror.titlePrefix') ||
      'lawcast-db-mirror';
    const keepLocalDump =
      this.configService.get<boolean>('fileMirror.keepLocalDump', false) ??
      false;
    const mirrorAnnouncementChannelId =
      this.configService.get<string>('fileMirror.discordChannelId') || '';

    const dump = await this.databaseDumpService.createSanitizedDump();

    try {
      const upload = await this.fileKiwiClientService.uploadFile({
        filePath: dump.dumpPath,
        title: `${titlePrefix}-${dump.dumpFileName}`,
      });

      logAndBridge({
        method: 'log',
        message: `Database mirror uploaded successfully (folderId=${upload.folderId}, fileId=${upload.fileId}, shareUrl=${upload.shareUrl})`,
        logger: this.logger,
        context: DbMirrorService.name,
        discordBridge: this.discordBridge,
        bridgeMessage: `DB mirror uploaded: folder=${upload.folderId}, file=${upload.fileId}`,
        metadata: {
          folderId: upload.folderId,
          fileId: upload.fileId,
          shareUrl: upload.shareUrl,
        },
      });

      if (mirrorAnnouncementChannelId) {
        await this.discordBridge?.upsertDbMirrorAnnouncement({
          channelId: mirrorAnnouncementChannelId,
          shareUrl: upload.shareUrl,
          dumpedAt: new Date(),
          dumpFileName: dump.dumpFileName,
          folderId: upload.folderId,
          fileId: upload.fileId,
        });
      }
    } finally {
      if (!keepLocalDump) {
        await this.databaseDumpService.removeDumpFile(dump.dumpPath);
      }
    }
  }
}
