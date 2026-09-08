import { Injectable } from '@nestjs/common';
import { ChatInputCommandInteraction, Interaction } from 'discord.js';
import { BridgeCommandContext } from './discord-bridge.types';
import { DiscordBridgeAdminAnnouncementCommandService } from './discord-bridge-admin-announcement-command.service';
import { DiscordBridgeOperationsCommandsService } from './discord-bridge-operations-commands.service';
import { DiscordBridgeDiscussionsCommandsService } from './discord-bridge-discussions-commands.service';

@Injectable()
export class DiscordBridgeCommandsService {
  constructor(
    private readonly operationsCommands: DiscordBridgeOperationsCommandsService,
    private readonly adminAnnouncementCommands: DiscordBridgeAdminAnnouncementCommandService,
    private readonly discussionsCommands: DiscordBridgeDiscussionsCommandsService,
  ) {}

  async execute(
    interaction: ChatInputCommandInteraction,
    ctx: BridgeCommandContext,
  ): Promise<void> {
    if (await this.operationsCommands.execute(interaction, ctx)) {
      return;
    }

    if (await this.discussionsCommands.executeCommand(interaction)) {
      return;
    }

    await this.adminAnnouncementCommands.executeCommand(interaction);
  }

  async executeComponentInteraction(
    interaction: Interaction,
  ): Promise<boolean> {
    if (
      await this.discussionsCommands.executeComponentInteraction(interaction)
    ) {
      return true;
    }

    return this.adminAnnouncementCommands.executeComponentInteraction(
      interaction,
    );
  }
}
