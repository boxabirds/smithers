import type pg from 'pg';
import {
  fullTextSearch,
  getEntitiesByFilters,
  getEntityById,
  type EntityRow,
} from '../db/entities.js';

// Default guild ID for single-guild v1
const DEFAULT_GUILD_ID = '0';

async function getGuildId(pool: pg.Pool): Promise<string> {
  const result = await pool.query('SELECT guild_id FROM guild_config LIMIT 1');
  return result.rows.length > 0 ? String(result.rows[0].guild_id) : DEFAULT_GUILD_ID;
}

function formatEntity(row: EntityRow): Record<string, unknown> {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    status: row.status,
    confidence: row.confidence,
    first_seen: row.first_seen,
    last_seen: row.last_seen,
    mentions: row.mentions,
    metadata: row.metadata,
  };
}

export async function handleSearchKnowledge(
  pool: pg.Pool,
  params: { query: string; type?: string; status?: string; since?: string; limit?: number },
): Promise<Record<string, unknown>> {
  if (!params.query || params.query.trim() === '') {
    return { error: 'query parameter is required and must be non-empty' };
  }

  const guildId = await getGuildId(pool);
  const results = await fullTextSearch(pool, guildId, params.query, {
    type: params.type,
    status: params.status,
    since: params.since ? new Date(params.since) : undefined,
    limit: params.limit ?? 20,
  });

  return { entities: results.map(formatEntity), count: results.length };
}

export async function handleGetActions(
  pool: pg.Pool,
  params: { assignee?: string; status?: string; since?: string },
): Promise<Record<string, unknown>> {
  const guildId = await getGuildId(pool);
  const statusFilter = params.status === 'all' ? undefined : (params.status ?? 'open');

  const results = await getEntitiesByFilters(pool, guildId, {
    type: 'action',
    status: statusFilter,
    since: params.since ? new Date(params.since) : undefined,
    assignee: params.assignee,
  });

  return { actions: results.map(formatEntity), count: results.length };
}

export async function handleGetOpenQuestions(
  pool: pg.Pool,
  params: { since?: string; channel?: string },
): Promise<Record<string, unknown>> {
  const guildId = await getGuildId(pool);

  let results: EntityRow[];

  if (params.channel) {
    // Join through evidence to filter by channel
    const query = await pool.query(
      `SELECT DISTINCT e.* FROM entities e
       JOIN entity_evidence ee ON e.id = ee.entity_id
       JOIN messages m ON ee.message_id = m.id
       WHERE e.guild_id = $1 AND e.type = 'question' AND e.status = 'open'
       AND m.channel_id = $2
       ${params.since ? 'AND e.first_seen >= $3' : ''}
       ORDER BY e.first_seen DESC`,
      params.since ? [guildId, params.channel, new Date(params.since)] : [guildId, params.channel],
    );
    results = query.rows as EntityRow[];
  } else {
    results = await getEntitiesByFilters(pool, guildId, {
      type: 'question',
      status: 'open',
      since: params.since ? new Date(params.since) : undefined,
    });
  }

  return { questions: results.map(formatEntity), count: results.length };
}

export async function handleGetProjects(
  pool: pg.Pool,
  params: { status?: string },
): Promise<Record<string, unknown>> {
  const guildId = await getGuildId(pool);
  const statusMap: Record<string, string | undefined> = {
    active: 'open',
    stale: 'stale',
    all: undefined,
  };
  const statusFilter = statusMap[params.status ?? 'all'];

  const results = await getEntitiesByFilters(pool, guildId, {
    type: 'project',
    status: statusFilter,
  });

  return { projects: results.map(formatEntity), count: results.length };
}

export async function handleGetDecisions(
  pool: pg.Pool,
  params: { since?: string; limit?: number },
): Promise<Record<string, unknown>> {
  const guildId = await getGuildId(pool);

  const results = await getEntitiesByFilters(pool, guildId, {
    type: 'decision',
    since: params.since ? new Date(params.since) : undefined,
    limit: params.limit ?? 20,
  });

  return { decisions: results.map(formatEntity), count: results.length };
}

export async function handleGetDigest(
  pool: pg.Pool,
  params: { since: string; until?: string },
): Promise<Record<string, unknown>> {
  if (!params.since) {
    return { error: 'since parameter is required' };
  }

  const sinceDate = new Date(params.since);
  const untilDate = params.until ? new Date(params.until) : new Date();

  if (sinceDate > untilDate) {
    return { error: 'since must be before until' };
  }

  const guildId = await getGuildId(pool);

  const result = await pool.query(
    `SELECT * FROM entities WHERE guild_id = $1 AND last_seen >= $2 AND last_seen <= $3 ORDER BY last_seen DESC`,
    [guildId, sinceDate, untilDate],
  );

  const entities = result.rows as EntityRow[];

  const summary: Record<string, number> = {
    projects: 0, actions: 0, decisions: 0, questions: 0, concepts: 0, resources: 0,
  };
  for (const e of entities) {
    const key = e.type + 's';
    if (key in summary) summary[key]++;
  }

  return {
    period: { since: params.since, until: params.until ?? untilDate.toISOString() },
    summary: { ...summary, total: entities.length },
    entities: entities.map(formatEntity),
  };
}

export async function handleGetEntityContext(
  pool: pg.Pool,
  params: { entity_id: number; messages_before?: number; messages_after?: number },
): Promise<Record<string, unknown>> {
  const entity = await getEntityById(pool, params.entity_id);
  if (!entity) {
    return { error: `Entity ${params.entity_id} not found` };
  }

  const messagesBefore = params.messages_before ?? 5;
  const messagesAfter = params.messages_after ?? 5;

  // Get evidence message IDs
  const evidenceResult = await pool.query(
    'SELECT message_id FROM entity_evidence WHERE entity_id = $1',
    [params.entity_id],
  );

  const evidenceIds = evidenceResult.rows.map((r: Record<string, unknown>) => String(r.message_id));

  if (evidenceIds.length === 0) {
    return { entity: formatEntity(entity), messages: [] };
  }

  // For each evidence message, get surrounding context
  const allMessages = new Map<string, Record<string, unknown>>();

  for (const msgId of evidenceIds) {
    const msgResult = await pool.query('SELECT * FROM messages WHERE id = $1', [msgId]);
    if (msgResult.rows.length === 0) continue;

    const msg = msgResult.rows[0];
    allMessages.set(String(msg.id), msg);

    // Get messages before
    if (messagesBefore > 0) {
      const before = await pool.query(
        `SELECT * FROM messages WHERE channel_id = $1 AND created_at < $2 AND deleted_at IS NULL
         ORDER BY created_at DESC LIMIT $3`,
        [msg.channel_id, msg.created_at, messagesBefore],
      );
      for (const m of before.rows) {
        allMessages.set(String(m.id), m);
      }
    }

    // Get messages after
    if (messagesAfter > 0) {
      const after = await pool.query(
        `SELECT * FROM messages WHERE channel_id = $1 AND created_at > $2 AND deleted_at IS NULL
         ORDER BY created_at ASC LIMIT $3`,
        [msg.channel_id, msg.created_at, messagesAfter],
      );
      for (const m of after.rows) {
        allMessages.set(String(m.id), m);
      }
    }
  }

  // Sort chronologically
  const sortedMessages = [...allMessages.values()].sort(
    (a, b) => new Date(a.created_at as string).getTime() - new Date(b.created_at as string).getTime(),
  );

  return {
    entity: formatEntity(entity),
    messages: sortedMessages.map((m) => ({
      id: String(m.id),
      channel_id: String(m.channel_id),
      author_name: m.author_name,
      content: m.content,
      created_at: m.created_at,
    })),
  };
}
