import { REST, Routes, SlashCommandBuilder, SlashCommandSubcommandBuilder } from 'discord.js';
import { DEFAULT_LOOKBACK_DAYS, MIN_DAYS_PARAM, VALID_ENTITY_TYPES } from './constants.js';

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

  const search = new SlashCommandBuilder()
    .setName('search')
    .setDescription('Search entities by keyword')
    .addStringOption((opt) =>
      opt.setName('query').setDescription('Search query').setRequired(true),
    ) as SlashCommandBuilder;

  const entityTypeChoices = VALID_ENTITY_TYPES.map((t) => ({ name: t, value: t }));

  const correct = new SlashCommandBuilder()
    .setName('correct')
    .setDescription('Correct entity extraction errors')
    .addSubcommand((sub: SlashCommandSubcommandBuilder) =>
      sub
        .setName('retype')
        .setDescription('Change an entity\'s type')
        .addIntegerOption((opt) =>
          opt.setName('entity_id').setDescription('Entity ID to correct').setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName('new_type')
            .setDescription('New entity type')
            .setRequired(true)
            .addChoices(...entityTypeChoices),
        ),
    )
    .addSubcommand((sub: SlashCommandSubcommandBuilder) =>
      sub
        .setName('retitle')
        .setDescription('Fix an entity\'s title')
        .addIntegerOption((opt) =>
          opt.setName('entity_id').setDescription('Entity ID to correct').setRequired(true),
        )
        .addStringOption((opt) =>
          opt.setName('new_title').setDescription('New entity title').setRequired(true),
        ),
    )
    .addSubcommand((sub: SlashCommandSubcommandBuilder) =>
      sub
        .setName('resolve')
        .setDescription('Mark an entity as resolved')
        .addIntegerOption((opt) =>
          opt.setName('entity_id').setDescription('Entity ID to resolve').setRequired(true),
        ),
    )
    .addSubcommand((sub: SlashCommandSubcommandBuilder) =>
      sub
        .setName('delete')
        .setDescription('Soft-delete a bad entity')
        .addIntegerOption((opt) =>
          opt.setName('entity_id').setDescription('Entity ID to delete').setRequired(true),
        ),
    )
    .addSubcommand((sub: SlashCommandSubcommandBuilder) =>
      sub
        .setName('merge')
        .setDescription('Merge a duplicate entity into another')
        .addIntegerOption((opt) =>
          opt.setName('entity_id').setDescription('Source entity ID to merge from').setRequired(true),
        )
        .addIntegerOption((opt) =>
          opt.setName('into_entity_id').setDescription('Target entity ID to merge into').setRequired(true),
        ),
    ) as SlashCommandBuilder;

  return [actions, questions, digest, projects, decisions, status, search, correct];
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
