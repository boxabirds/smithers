import type pg from 'pg';

export interface EntityRow {
  id?: number;
  guild_id: string;
  type: string;
  title: string;
  body: string | null;
  status: string;
  confidence: number;
  first_seen: Date;
  last_seen: Date;
  last_updated?: Date;
  mentions: number;
  metadata: Record<string, unknown>;
}

export interface EntityMatch {
  id: number;
  title: string;
  similarityScore: number;
}

export interface SearchFilters {
  type?: string;
  status?: string;
  since?: Date;
  limit?: number;
}

export async function searchSimilarEntities(
  pool: pg.Pool,
  guildId: string,
  type: string,
  title: string,
  threshold: number,
): Promise<EntityMatch[]> {
  const result = await pool.query(
    `SELECT id, title, similarity(title, $1) AS score
     FROM entities
     WHERE guild_id = $2 AND type = $3 AND similarity(title, $1) >= $4
     ORDER BY score DESC`,
    [title, guildId, type, threshold],
  );
  return result.rows.map((r: Record<string, unknown>) => ({
    id: r.id as number,
    title: r.title as string,
    similarityScore: r.score as number,
  }));
}

export async function insertEntity(pool: pg.Pool, entity: EntityRow): Promise<number> {
  const result = await pool.query(
    `INSERT INTO entities (guild_id, type, title, body, status, confidence, first_seen, last_seen, mentions, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      entity.guild_id, entity.type, entity.title, entity.body, entity.status,
      entity.confidence, entity.first_seen, entity.last_seen, entity.mentions,
      JSON.stringify(entity.metadata),
    ],
  );
  return result.rows[0].id as number;
}

export async function updateEntity(
  pool: pg.Pool,
  id: number,
  updates: Partial<Pick<EntityRow, 'body' | 'status' | 'last_seen' | 'mentions' | 'metadata'>>,
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (updates.body !== undefined) { sets.push(`body = $${idx++}`); values.push(updates.body); }
  if (updates.status !== undefined) { sets.push(`status = $${idx++}`); values.push(updates.status); }
  if (updates.last_seen !== undefined) { sets.push(`last_seen = $${idx++}`); values.push(updates.last_seen); }
  if (updates.mentions !== undefined) { sets.push(`mentions = $${idx++}`); values.push(updates.mentions); }
  if (updates.metadata !== undefined) { sets.push(`metadata = $${idx++}`); values.push(JSON.stringify(updates.metadata)); }

  sets.push(`last_updated = now()`);

  if (sets.length === 1) return; // only last_updated, nothing to update

  values.push(id);
  await pool.query(`UPDATE entities SET ${sets.join(', ')} WHERE id = $${idx}`, values);
}

export async function linkEvidence(
  pool: pg.Pool,
  entityId: number,
  messageId: string,
  extractionId: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO entity_evidence (entity_id, message_id, extraction_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (entity_id, message_id) DO NOTHING`,
    [entityId, messageId, extractionId],
  );
}

export async function fullTextSearch(
  pool: pg.Pool,
  guildId: string,
  query: string,
  filters: SearchFilters = {},
): Promise<EntityRow[]> {
  const conditions = [`guild_id = $1`];
  const values: unknown[] = [guildId];
  let idx = 2;

  // Full-text search
  conditions.push(`to_tsvector('english', title || ' ' || coalesce(body, '')) @@ plainto_tsquery('english', $${idx})`);
  values.push(query);
  idx++;

  if (filters.type) {
    conditions.push(`type = $${idx++}`);
    values.push(filters.type);
  }
  if (filters.status) {
    conditions.push(`status = $${idx++}`);
    values.push(filters.status);
  }
  if (filters.since) {
    conditions.push(`last_seen >= $${idx++}`);
    values.push(filters.since);
  }

  const limit = filters.limit ?? 20;

  const result = await pool.query(
    `SELECT *, ts_rank(to_tsvector('english', title || ' ' || coalesce(body, '')), plainto_tsquery('english', $2)) AS rank
     FROM entities
     WHERE ${conditions.join(' AND ')}
     ORDER BY rank DESC
     LIMIT $${idx}`,
    [...values, limit],
  );

  return result.rows as EntityRow[];
}

export async function markStaleEntities(pool: pg.Pool, staleDays: number = 14): Promise<number> {
  const result = await pool.query(
    `UPDATE entities SET status = 'stale', last_updated = now()
     WHERE status = 'open' AND last_seen < now() - interval '1 day' * $1`,
    [staleDays],
  );
  return result.rowCount ?? 0;
}

export async function getEntityById(pool: pg.Pool, id: number): Promise<EntityRow | null> {
  const result = await pool.query('SELECT * FROM entities WHERE id = $1', [id]);
  if (result.rows.length === 0) return null;
  return result.rows[0] as EntityRow;
}

export async function getEntitiesByFilters(
  pool: pg.Pool,
  guildId: string,
  filters: SearchFilters & { assignee?: string },
): Promise<EntityRow[]> {
  const conditions = [`guild_id = $1`];
  const values: unknown[] = [guildId];
  let idx = 2;

  if (filters.type) {
    conditions.push(`type = $${idx++}`);
    values.push(filters.type);
  }
  if (filters.status) {
    conditions.push(`status = $${idx++}`);
    values.push(filters.status);
  }
  if (filters.since) {
    conditions.push(`last_seen >= $${idx++}`);
    values.push(filters.since);
  }
  if (filters.assignee) {
    conditions.push(`metadata->>'assignee' = $${idx++}`);
    values.push(filters.assignee);
  }

  const limit = filters.limit ?? 20;

  const result = await pool.query(
    `SELECT * FROM entities WHERE ${conditions.join(' AND ')} ORDER BY last_seen DESC LIMIT $${idx}`,
    [...values, limit],
  );

  return result.rows as EntityRow[];
}
