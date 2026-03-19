import type { ChatInputCommandInteraction } from 'discord.js';
import type pg from 'pg';
import {
  handleGetActions,
  handleGetOpenQuestions,
  handleGetDigest,
  handleGetProjects,
  handleGetDecisions,
} from '../../mcp/tools.js';
import {
  formatActionsEmbed,
  formatQuestionsEmbed,
  formatDigestEmbed,
  formatProjectsEmbed,
  formatDecisionsEmbed,
  formatStatusEmbed,
  type StatusData,
} from './formatters.js';
import { DEFAULT_LOOKBACK_DAYS, MS_PER_DAY } from './constants.js';

export async function handleActionsCommand(
  interaction: ChatInputCommandInteraction,
  pool: pg.Pool,
): Promise<void> {
  const assignee = interaction.options.getString('assignee') ?? undefined;
  const result = await handleGetActions(pool, { assignee });
  const embed = formatActionsEmbed(result as { actions: Record<string, unknown>[]; count: number });
  await interaction.editReply({ embeds: [embed] });
}

export async function handleQuestionsCommand(
  interaction: ChatInputCommandInteraction,
  pool: pg.Pool,
): Promise<void> {
  const result = await handleGetOpenQuestions(pool, {});
  const embed = formatQuestionsEmbed(result as { questions: Record<string, unknown>[]; count: number });
  await interaction.editReply({ embeds: [embed] });
}

export async function handleDigestCommand(
  interaction: ChatInputCommandInteraction,
  pool: pg.Pool,
): Promise<void> {
  const days = interaction.options.getInteger('days') ?? DEFAULT_LOOKBACK_DAYS;
  const since = new Date(Date.now() - days * MS_PER_DAY).toISOString();
  const result = await handleGetDigest(pool, { since });
  const embed = formatDigestEmbed(
    result as { summary: Record<string, number>; entities: Record<string, unknown>[]; period: { since: string; until: string } },
    days,
  );
  await interaction.editReply({ embeds: [embed] });
}

export async function handleProjectsCommand(
  interaction: ChatInputCommandInteraction,
  pool: pg.Pool,
): Promise<void> {
  const result = await handleGetProjects(pool, { status: 'active' });
  const embed = formatProjectsEmbed(result as { projects: Record<string, unknown>[]; count: number });
  await interaction.editReply({ embeds: [embed] });
}

export async function handleDecisionsCommand(
  interaction: ChatInputCommandInteraction,
  pool: pg.Pool,
): Promise<void> {
  const days = interaction.options.getInteger('days') ?? DEFAULT_LOOKBACK_DAYS;
  const since = new Date(Date.now() - days * MS_PER_DAY).toISOString();
  const result = await handleGetDecisions(pool, { since });
  const embed = formatDecisionsEmbed(
    result as { decisions: Record<string, unknown>[]; count: number },
    days,
  );
  await interaction.editReply({ embeds: [embed] });
}

export async function handleStatusCommand(
  interaction: ChatInputCommandInteraction,
  pool: pg.Pool,
  botStartTime: Date,
): Promise<void> {
  const messageResult = await pool.query(
    'SELECT COUNT(*) AS count FROM messages WHERE deleted_at IS NULL',
  );
  const entityResult = await pool.query('SELECT COUNT(*) AS count FROM entities');

  const data: StatusData = {
    uptimeMs: Date.now() - botStartTime.getTime(),
    messageCount: parseInt(String(messageResult.rows[0].count), 10),
    entityCount: parseInt(String(entityResult.rows[0].count), 10),
  };

  const embed = formatStatusEmbed(data);
  await interaction.editReply({ embeds: [embed] });
}
