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
  deleted_at?: Date | null;
  mentions: number;
  metadata: Record<string, unknown>;
}

export interface EntityContextItem {
  id: number;
  type: string;
  title: string;
  body: string | null;
  status: string;
  assignee: string | null;
  tags: string[];
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

export interface CorrectionLogEntry {
  entity_id: number;
  user_id: string;
  operation: string;
  before_value: string | null;
  after_value: string | null;
}

export interface SoftDeleteResult {
  entity: EntityRow;
  alreadyDeleted: boolean;
}

export interface MergeResult {
  source: EntityRow;
  target: EntityRow;
}

export interface MergeError {
  error: string;
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
       AND deleted_at IS NULL
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
  const conditions = [`guild_id = $1`, `deleted_at IS NULL`];
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
     WHERE status = 'open' AND last_seen < now() - interval '1 day' * $1
       AND deleted_at IS NULL`,
    [staleDays],
  );
  return result.rowCount ?? 0;
}

export async function getEntityById(
  pool: pg.Pool,
  id: number,
  includeDeleted: boolean = false,
): Promise<EntityRow | null> {
  const deletedClause = includeDeleted ? '' : ' AND deleted_at IS NULL';
  const result = await pool.query(
    `SELECT * FROM entities WHERE id = $1${deletedClause}`,
    [id],
  );
  if (result.rows.length === 0) return null;
  return result.rows[0] as EntityRow;
}

export async function getEntitiesByFilters(
  pool: pg.Pool,
  guildId: string,
  filters: SearchFilters & { assignee?: string },
): Promise<EntityRow[]> {
  const conditions = [`guild_id = $1`, `deleted_at IS NULL`];
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

// ─── Entity Context for Extraction ───────────────────────────────

export async function getAllEntityContext(
  pool: pg.Pool,
  guildId: string,
): Promise<EntityContextItem[]> {
  const result = await pool.query(
    `SELECT id, type, title, body, status,
            metadata->>'assignee' AS assignee,
            COALESCE(
              (SELECT json_agg(t)::text FROM json_array_elements_text(metadata->'tags') AS t), '[]'
            ) AS tags_json
     FROM entities
     WHERE guild_id = $1 AND deleted_at IS NULL
     ORDER BY
       CASE type
         WHEN 'action' THEN 1
         WHEN 'question' THEN 2
         WHEN 'project' THEN 3
         WHEN 'decision' THEN 4
         WHEN 'concept' THEN 5
         WHEN 'resource' THEN 6
         ELSE 7
       END,
       last_seen DESC`,
    [guildId],
  );

  return result.rows.map((r: Record<string, unknown>) => ({
    id: r.id as number,
    type: r.type as string,
    title: r.title as string,
    body: (r.body as string) ?? null,
    status: r.status as string,
    assignee: (r.assignee as string) ?? null,
    tags: r.tags_json ? JSON.parse(r.tags_json as string) as string[] : [],
  }));
}

// ─── Correction Operations ───────────────────────────────────────

export async function retypeEntity(
  pool: pg.Pool,
  id: number,
  newType: string,
): Promise<EntityRow | null> {
  const result = await pool.query(
    `UPDATE entities SET type = $1, last_updated = now()
     WHERE id = $2 AND deleted_at IS NULL
     RETURNING *`,
    [newType, id],
  );
  if (result.rows.length === 0) return null;
  return result.rows[0] as EntityRow;
}

export async function retitleEntity(
  pool: pg.Pool,
  id: number,
  newTitle: string,
): Promise<EntityRow | null> {
  const result = await pool.query(
    `UPDATE entities SET title = $1, last_updated = now()
     WHERE id = $2 AND deleted_at IS NULL
     RETURNING *`,
    [newTitle, id],
  );
  if (result.rows.length === 0) return null;
  return result.rows[0] as EntityRow;
}

export async function resolveEntity(
  pool: pg.Pool,
  id: number,
): Promise<EntityRow | null> {
  const result = await pool.query(
    `UPDATE entities SET status = 'resolved', last_updated = now()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING *`,
    [id],
  );
  if (result.rows.length === 0) return null;
  return result.rows[0] as EntityRow;
}

export async function softDeleteEntity(
  pool: pg.Pool,
  id: number,
): Promise<SoftDeleteResult | null> {
  // First check if entity exists at all (including deleted)
  const check = await pool.query('SELECT * FROM entities WHERE id = $1', [id]);
  if (check.rows.length === 0) return null;

  const entity = check.rows[0] as EntityRow;
  if (entity.deleted_at) {
    return { entity, alreadyDeleted: true };
  }

  const result = await pool.query(
    `UPDATE entities SET deleted_at = now(), last_updated = now()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING *`,
    [id],
  );
  return { entity: result.rows[0] as EntityRow, alreadyDeleted: false };
}

export async function mergeEntities(
  pool: pg.Pool,
  sourceId: number,
  targetId: number,
): Promise<MergeResult | MergeError> {
  if (sourceId === targetId) {
    return { error: 'Cannot merge an entity into itself.' };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const sourceResult = await client.query(
      'SELECT * FROM entities WHERE id = $1 FOR UPDATE',
      [sourceId],
    );
    if (sourceResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { error: `Source entity #${sourceId} not found.` };
    }
    const source = sourceResult.rows[0] as EntityRow;
    if (source.deleted_at) {
      await client.query('ROLLBACK');
      return { error: `Source entity #${sourceId} has already been deleted.` };
    }

    const targetResult = await client.query(
      'SELECT * FROM entities WHERE id = $1 FOR UPDATE',
      [targetId],
    );
    if (targetResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { error: `Target entity #${targetId} not found.` };
    }
    const target = targetResult.rows[0] as EntityRow;
    if (target.deleted_at) {
      await client.query('ROLLBACK');
      return { error: `Target entity #${targetId} has already been deleted.` };
    }

    // Transfer evidence links (skip conflicts)
    await client.query(
      `UPDATE entity_evidence SET entity_id = $1
       WHERE entity_id = $2
       AND message_id NOT IN (SELECT message_id FROM entity_evidence WHERE entity_id = $1)`,
      [targetId, sourceId],
    );

    // Delete remaining evidence for source (conflicting ones)
    await client.query(
      'DELETE FROM entity_evidence WHERE entity_id = $1',
      [sourceId],
    );

    // Combine mention counts
    await client.query(
      `UPDATE entities SET mentions = mentions + $1, last_updated = now()
       WHERE id = $2`,
      [source.mentions, targetId],
    );

    // Soft-delete source
    await client.query(
      `UPDATE entities SET deleted_at = now(), last_updated = now()
       WHERE id = $1`,
      [sourceId],
    );

    await client.query('COMMIT');

    // Re-fetch updated rows
    const updatedSource = await pool.query('SELECT * FROM entities WHERE id = $1', [sourceId]);
    const updatedTarget = await pool.query('SELECT * FROM entities WHERE id = $1', [targetId]);

    return {
      source: updatedSource.rows[0] as EntityRow,
      target: updatedTarget.rows[0] as EntityRow,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function logCorrection(
  pool: pg.Pool,
  entry: CorrectionLogEntry,
): Promise<void> {
  await pool.query(
    `INSERT INTO entity_corrections (entity_id, user_id, operation, before_value, after_value)
     VALUES ($1, $2, $3, $4, $5)`,
    [entry.entity_id, entry.user_id, entry.operation, entry.before_value, entry.after_value],
  );
}
