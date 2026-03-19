import type { ChatInputCommandInteraction } from 'discord.js';
import type pg from 'pg';
import {
  handleActionsCommand,
  handleQuestionsCommand,
  handleDigestCommand,
  handleProjectsCommand,
  handleDecisionsCommand,
  handleStatusCommand,
  handleSearchCommand,
  handleCorrectCommand,
} from './handlers.js';
import { formatErrorEmbed } from './formatters.js';

type CommandHandler = (
  interaction: ChatInputCommandInteraction,
  pool: pg.Pool,
  botStartTime: Date,
) => Promise<void>;

const COMMAND_MAP: Record<string, CommandHandler> = {
  actions: handleActionsCommand,
  questions: handleQuestionsCommand,
  digest: handleDigestCommand,
  projects: handleProjectsCommand,
  decisions: handleDecisionsCommand,
  status: handleStatusCommand,
  search: handleSearchCommand,
  correct: handleCorrectCommand,
};

export const KNOWN_COMMAND_NAMES = Object.keys(COMMAND_MAP);

export async function handleSlashCommand(
  interaction: ChatInputCommandInteraction,
  pool: pg.Pool,
  botStartTime: Date,
): Promise<void> {
  const handler = COMMAND_MAP[interaction.commandName];

  if (!handler) {
    await interaction.reply({
      embeds: [formatErrorEmbed(`Unknown command: ${interaction.commandName}`)],
    });
    return;
  }

  try {
    await interaction.deferReply();
    await handler(interaction, pool, botStartTime);
  } catch (err) {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      service: 'bot',
      message: `Slash command /${interaction.commandName} failed: ${err instanceof Error ? err.message : err}`,
      guildId: interaction.guildId,
    }));

    const errorEmbed = formatErrorEmbed('Something went wrong. Please try again later.');

    // If we already deferred, edit the reply; otherwise send a new reply
    try {
      if (interaction.deferred) {
        await interaction.editReply({ embeds: [errorEmbed] });
      } else {
        await interaction.reply({ embeds: [errorEmbed] });
      }
    } catch {
      // Interaction may have expired; nothing more we can do
    }
  }
}
