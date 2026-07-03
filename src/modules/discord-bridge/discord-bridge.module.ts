import { Global, Module } from '@nestjs/common';
import { DiscordBridgeService } from './discord-bridge.service';
import { DiscordBridgeCommandsService } from './discord-bridge-commands.service';
import { DiscordBridgeAdminAnnouncementCommandService } from './discord-bridge-admin-announcement-command.service';
import { DiscordBridgeOperationsCommandsService } from './discord-bridge-operations-commands.service';

@Global()
@Module({
  providers: [
    DiscordBridgeOperationsCommandsService,
    DiscordBridgeAdminAnnouncementCommandService,
    DiscordBridgeCommandsService,
    DiscordBridgeService,
  ],
  exports: [DiscordBridgeService],
})
export class DiscordBridgeModule {}
