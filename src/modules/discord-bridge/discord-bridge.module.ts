import { Global, Module } from '@nestjs/common';
import { DiscordBridgeService } from './discord-bridge.service';
import { DiscordBridgeCommandsService } from './discord-bridge-commands.service';

@Global()
@Module({
  providers: [DiscordBridgeCommandsService, DiscordBridgeService],
  exports: [DiscordBridgeService],
})
export class DiscordBridgeModule {}
