import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import { DEFAULT_LOOKBACK_DAYS, MIN_DAYS_PARAM } from './constants.js';

export function buildCommandDefinitions(): SlashCommandBuilder[] {
  const actions = new SlashCommandBuilder()
    .setName('actions')
    .setDescription('Show open action items')
    .addStringOption((opt) =>
      opt.setName('assignee').setDescription('Filter by assignee').setRequired(false),
    ) as SlashCommandBuilder;

  const questions = new SlashCommandBuilder()
    .setName('questions')
    .setDescription('Show unanswered questions');

  const digest = new SlashCommandBuilder()
    .setName('digest')
    .setDescription('Show a summary of recent activity')
    .addIntegerOption((opt) =>
      opt
        .setName('days')
        .setDescription(`Lookback window in days (default ${DEFAULT_LOOKBACK_DAYS})`)
        .setRequired(false)
        .setMinValue(MIN_DAYS_PARAM),
    ) as SlashCommandBuilder;

  const projects = new SlashCommandBuilder()
    .setName('projects')
    .setDescription('Show active projects');

  const decisions = new SlashCommandBuilder()
    .setName('decisions')
    .setDescription('Show recent decisions')
    .addIntegerOption((opt) =>
      opt
        .setName('days')
        .setDescription(`Lookback window in days (default ${DEFAULT_LOOKBACK_DAYS})`)
        .setRequired(false)
        .setMinValue(MIN_DAYS_PARAM),
    ) as SlashCommandBuilder;

  const status = new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show bot status (uptime, messages captured, entities extracted)');

  return [actions, questions, digest, projects, decisions, status];
}

export async function registerCommands(clientId: string, token: string): Promise<void> {
  const commands = buildCommandDefinitions();
  const rest = new REST({ version: '10' }).setToken(token);

  await rest.put(Routes.applicationCommands(clientId), {
    body: commands.map((c) => c.toJSON()),
  });

  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'info',
    service: 'bot',
    message: `Registered ${commands.length} slash commands`,
  }));
}
