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
  fullTextSearch,
  getEntityById,
  retypeEntity,
  retitleEntity,
  resolveEntity,
  softDeleteEntity,
  mergeEntities,
  logCorrection,
} from '../../db/entities.js';
import {
  formatActionsEmbed,
  formatQuestionsEmbed,
  formatDigestEmbed,
  formatProjectsEmbed,
  formatDecisionsEmbed,
  formatStatusEmbed,
  formatErrorEmbed,
  formatSearchResultsEmbed,
  formatCorrectionEmbed,
  formatMergeEmbed,
  type StatusData,
  type SearchResultEntity,
} from './formatters.js';
import { DEFAULT_LOOKBACK_DAYS, MS_PER_DAY, VALID_ENTITY_TYPES, MAX_SEARCH_RESULTS } from './constants.js';

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

// ─── Search Command ──────────────────────────────────────────────

export async function handleSearchCommand(
  interaction: ChatInputCommandInteraction,
  pool: pg.Pool,
): Promise<void> {
  const query = interaction.options.getString('query', true);
  const guildId = interaction.guildId!;

  const entities = await fullTextSearch(pool, guildId, query, { limit: MAX_SEARCH_RESULTS });

  const results: SearchResultEntity[] = entities.map((e) => ({
    id: e.id!,
    type: e.type,
    title: e.title,
    status: e.status,
  }));

  const embed = formatSearchResultsEmbed(results, query);
  await interaction.editReply({ embeds: [embed] });
}

// ─── Correct Command (Dispatcher) ────────────────────────────────

export async function handleCorrectCommand(
  interaction: ChatInputCommandInteraction,
  pool: pg.Pool,
): Promise<void> {
  const subcommand = interaction.options.getSubcommand(true);

  const handlers: Record<string, (i: ChatInputCommandInteraction, p: pg.Pool) => Promise<void>> = {
    retype: handleCorrectRetype,
    retitle: handleCorrectRetitle,
    resolve: handleCorrectResolve,
    delete: handleCorrectDelete,
    merge: handleCorrectMerge,
  };

  const handler = handlers[subcommand];
  if (!handler) {
    await interaction.editReply({ embeds: [formatErrorEmbed(`Unknown subcommand: ${subcommand}`)] });
    return;
  }

  await handler(interaction, pool);
}

// ─── Correct Subcommand Handlers ─────────────────────────────────

async function handleCorrectRetype(
  interaction: ChatInputCommandInteraction,
  pool: pg.Pool,
): Promise<void> {
  const entityId = interaction.options.getInteger('entity_id', true);
  const newType = interaction.options.getString('new_type', true);
  const userId = interaction.user.id;

  // Validate type (also enforced by Discord choices, but defence in depth)
  if (!VALID_ENTITY_TYPES.includes(newType as typeof VALID_ENTITY_TYPES[number])) {
    await interaction.editReply({
      embeds: [formatErrorEmbed(`Invalid type. Valid types: ${VALID_ENTITY_TYPES.join(', ')}`)],
    });
    return;
  }

  const oldEntity = await getEntityById(pool, entityId);
  if (!oldEntity) {
    await interaction.editReply({
      embeds: [formatErrorEmbed(`Entity #${entityId} not found.`)],
    });
    return;
  }

  const oldType = oldEntity.type;
  const updated = await retypeEntity(pool, entityId, newType);
  if (!updated) {
    await interaction.editReply({
      embeds: [formatErrorEmbed(`Entity #${entityId} not found.`)],
    });
    return;
  }

  await logCorrection(pool, {
    entity_id: entityId,
    user_id: userId,
    operation: 'retype',
    before_value: oldType,
    after_value: newType,
  });

  const embed = formatCorrectionEmbed('retype', entityId, updated.title, oldType, newType, userId);
  await interaction.editReply({ embeds: [embed] });
}

async function handleCorrectRetitle(
  interaction: ChatInputCommandInteraction,
  pool: pg.Pool,
): Promise<void> {
  const entityId = interaction.options.getInteger('entity_id', true);
  const newTitle = interaction.options.getString('new_title', true);
  const userId = interaction.user.id;

  const oldEntity = await getEntityById(pool, entityId);
  if (!oldEntity) {
    await interaction.editReply({
      embeds: [formatErrorEmbed(`Entity #${entityId} not found.`)],
    });
    return;
  }

  const oldTitle = oldEntity.title;
  const updated = await retitleEntity(pool, entityId, newTitle);
  if (!updated) {
    await interaction.editReply({
      embeds: [formatErrorEmbed(`Entity #${entityId} not found.`)],
    });
    return;
  }

  await logCorrection(pool, {
    entity_id: entityId,
    user_id: userId,
    operation: 'retitle',
    before_value: oldTitle,
    after_value: newTitle,
  });

  const embed = formatCorrectionEmbed('retitle', entityId, updated.title, oldTitle, newTitle, userId);
  await interaction.editReply({ embeds: [embed] });
}

async function handleCorrectResolve(
  interaction: ChatInputCommandInteraction,
  pool: pg.Pool,
): Promise<void> {
  const entityId = interaction.options.getInteger('entity_id', true);
  const userId = interaction.user.id;

  const oldEntity = await getEntityById(pool, entityId);
  if (!oldEntity) {
    await interaction.editReply({
      embeds: [formatErrorEmbed(`Entity #${entityId} not found.`)],
    });
    return;
  }

  const oldStatus = oldEntity.status;
  const updated = await resolveEntity(pool, entityId);
  if (!updated) {
    await interaction.editReply({
      embeds: [formatErrorEmbed(`Entity #${entityId} not found.`)],
    });
    return;
  }

  await logCorrection(pool, {
    entity_id: entityId,
    user_id: userId,
    operation: 'resolve',
    before_value: oldStatus,
    after_value: 'resolved',
  });

  const embed = formatCorrectionEmbed('resolve', entityId, updated.title, oldStatus, 'resolved', userId);
  await interaction.editReply({ embeds: [embed] });
}

async function handleCorrectDelete(
  interaction: ChatInputCommandInteraction,
  pool: pg.Pool,
): Promise<void> {
  const entityId = interaction.options.getInteger('entity_id', true);
  const userId = interaction.user.id;

  const result = await softDeleteEntity(pool, entityId);
  if (!result) {
    await interaction.editReply({
      embeds: [formatErrorEmbed(`Entity #${entityId} not found.`)],
    });
    return;
  }

  if (result.alreadyDeleted) {
    await interaction.editReply({
      embeds: [formatErrorEmbed(`Entity #${entityId} has already been deleted.`)],
    });
    return;
  }

  await logCorrection(pool, {
    entity_id: entityId,
    user_id: userId,
    operation: 'delete',
    before_value: 'active',
    after_value: 'deleted',
  });

  const embed = formatCorrectionEmbed('delete', entityId, result.entity.title, 'active', 'deleted', userId);
  await interaction.editReply({ embeds: [embed] });
}

async function handleCorrectMerge(
  interaction: ChatInputCommandInteraction,
  pool: pg.Pool,
): Promise<void> {
  const sourceId = interaction.options.getInteger('entity_id', true);
  const targetId = interaction.options.getInteger('into_entity_id', true);
  const userId = interaction.user.id;

  const result = await mergeEntities(pool, sourceId, targetId);

  if ('error' in result) {
    await interaction.editReply({
      embeds: [formatErrorEmbed(result.error)],
    });
    return;
  }

  await logCorrection(pool, {
    entity_id: sourceId,
    user_id: userId,
    operation: 'merge',
    before_value: String(sourceId),
    after_value: String(targetId),
  });

  const embed = formatMergeEmbed(
    { id: sourceId, title: result.source.title },
    { id: targetId, title: result.target.title, mentions: result.target.mentions },
    userId,
  );
  await interaction.editReply({ embeds: [embed] });
}
