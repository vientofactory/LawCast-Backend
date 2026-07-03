import { Injectable } from '@nestjs/common';
import { ChatInputCommandInteraction, Interaction } from 'discord.js';
import { BridgeCommandContext } from './discord-bridge.types';
import { DiscordBridgeAdminAnnouncementCommandService } from './discord-bridge-admin-announcement-command.service';
import { DiscordBridgeOperationsCommandsService } from './discord-bridge-operations-commands.service';

@Injectable()
export class DiscordBridgeCommandsService {
  constructor(
    private readonly operationsCommands: DiscordBridgeOperationsCommandsService,
    private readonly adminAnnouncementCommands: DiscordBridgeAdminAnnouncementCommandService,
  ) {}

  async execute(
    interaction: ChatInputCommandInteraction,
    ctx: BridgeCommandContext,
  ): Promise<void> {
    if (await this.operationsCommands.execute(interaction, ctx)) {
      return;
    }

    await this.adminAnnouncementCommands.executeCommand(interaction);
  }

  async executeComponentInteraction(
    interaction: Interaction,
  ): Promise<boolean> {
    return this.adminAnnouncementCommands.executeComponentInteraction(
      interaction,
    );
  }
}
