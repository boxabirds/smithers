import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { runMigrations } from '../src/db/migrate.js';
import { mergeEntities } from '../src/extraction/merger.js';
import { insertEntity, getEntityById } from '../src/db/entities.js';
import { insertMessage } from '../src/db/messages.js';
import type { ExtractedEntity } from '../src/extraction/extractor.js';
import type { MessageRow } from '../src/db/messages.js';

const TEST_DB_URL = process.env.DATABASE_URL || 'postgres://secretary:secretpassword@localhost:5432/secretary';

function makeMsg(id: string): MessageRow {
  return {
    id, channel_id: '100', guild_id: '200', author_id: '300', author_name: 'user',
    content: 'test', created_at: new Date('2024-01-15T10:00:00Z'), has_attachments: false,
    reply_to_id: null, thread_id: null,
  };
}

function makeExtracted(overrides: Partial<ExtractedEntity> = {}): ExtractedEntity {
  return {
    type: 'action',
    title: 'Deploy authentication service',
    body: 'Need to deploy the auth service to production',
    status: 'open',
    confidence: 0.9,
    people: ['alice'],
    metadata: { assignee: 'alice', tags: ['auth', 'deploy'] },
    evidenceMessageIds: [],
    ...overrides,
  };
}

describe('Entity Merger', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE entity_evidence, entities, extraction_runs, messages CASCADE');
  });

  it('creates new entity when no match exists', async () => {
    // Need an extraction run for FK
    const runResult = await pool.query(
      `INSERT INTO extraction_runs (guild_id, window_start, window_end, message_count, model)
       VALUES ('200', now(), now(), 1, 'test') RETURNING id`,
    );

    const result = await mergeEntities(pool, '200', [makeExtracted()], runResult.rows[0].id);
    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);
  });

  it('updates existing entity when similar match found', async () => {
    const existingId = await insertEntity(pool, {
      guild_id: '200', type: 'action', title: 'Deploy authentication service',
      body: 'Auth deployment', status: 'open', confidence: 1.0,
      first_seen: new Date('2024-01-01'), last_seen: new Date('2024-01-01'), mentions: 1,
      metadata: { tags: ['auth'] },
    });

    const runResult = await pool.query(
      `INSERT INTO extraction_runs (guild_id, window_start, window_end, message_count, model)
       VALUES ('200', now(), now(), 1, 'test') RETURNING id`,
    );

    const result = await mergeEntities(
      pool, '200',
      [makeExtracted({ title: 'Deploy auth service' })],
      runResult.rows[0].id,
    );

    expect(result.updated).toBe(1);
    expect(result.created).toBe(0);

    const entity = await getEntityById(pool, existingId);
    expect(entity!.mentions).toBe(2);
    // Tags should be merged
    const tags = (entity!.metadata as Record<string, unknown>).tags as string[];
    expect(tags).toContain('auth');
    expect(tags).toContain('deploy');
  });

  it('links evidence to existing messages', async () => {
    await insertMessage(pool, makeMsg('5001'));
    await insertMessage(pool, makeMsg('5002'));

    const runResult = await pool.query(
      `INSERT INTO extraction_runs (guild_id, window_start, window_end, message_count, model)
       VALUES ('200', now(), now(), 1, 'test') RETURNING id`,
    );

    await mergeEntities(
      pool, '200',
      [makeExtracted({ evidenceMessageIds: ['5001', '5002'] })],
      runResult.rows[0].id,
    );

    const evidence = await pool.query('SELECT * FROM entity_evidence');
    expect(evidence.rows.length).toBe(2);
  });

  it('deduplicates within batch', async () => {
    const runResult = await pool.query(
      `INSERT INTO extraction_runs (guild_id, window_start, window_end, message_count, model)
       VALUES ('200', now(), now(), 1, 'test') RETURNING id`,
    );

    const result = await mergeEntities(pool, '200', [
      makeExtracted({ title: 'Deploy auth service' }),
      makeExtracted({ title: 'deploy auth service', metadata: { tags: ['urgent'] } }),
    ], runResult.rows[0].id);

    expect(result.created).toBe(1); // merged locally, only 1 created
    expect(result.updated).toBe(0);
  });

  // ─── resolves_existing_id Tests ─────────────────────────────────

  it('updates entity directly by resolves_existing_id', async () => {
    const existingId = await insertEntity(pool, {
      guild_id: '200', type: 'action', title: 'Set up Redis',
      body: 'Configure Redis', status: 'open', confidence: 0.9,
      first_seen: new Date(), last_seen: new Date(), mentions: 1,
      metadata: { assignee: 'bob' },
    });

    const runResult = await pool.query(
      `INSERT INTO extraction_runs (guild_id, window_start, window_end, message_count, model)
       VALUES ('200', now(), now(), 1, 'test') RETURNING id`,
    );

    const result = await mergeEntities(pool, '200', [
      makeExtracted({
        resolvesExistingId: existingId,
        status: 'resolved',
        confidence: 0.9,
        body: 'Redis config completed',
      }),
    ], runResult.rows[0].id);

    expect(result.updated).toBe(1);
    expect(result.created).toBe(0);

    const entity = await getEntityById(pool, existingId);
    expect(entity!.status).toBe('resolved');
    expect(entity!.mentions).toBe(2);
  });

  it('skips update when resolves_existing_id does not exist', async () => {
    const runResult = await pool.query(
      `INSERT INTO extraction_runs (guild_id, window_start, window_end, message_count, model)
       VALUES ('200', now(), now(), 1, 'test') RETURNING id`,
    );

    const result = await mergeEntities(pool, '200', [
      makeExtracted({ resolvesExistingId: 999999, status: 'resolved', confidence: 0.9 }),
    ], runResult.rows[0].id);

    expect(result.skipped).toBe(1);
    expect(result.updated).toBe(0);
  });

  it('skips update when resolves_existing_id references deleted entity', async () => {
    const existingId = await insertEntity(pool, {
      guild_id: '200', type: 'action', title: 'Old action',
      body: null, status: 'open', confidence: 0.9,
      first_seen: new Date(), last_seen: new Date(), mentions: 1,
      metadata: {},
    });
    await pool.query('UPDATE entities SET deleted_at = now() WHERE id = $1', [existingId]);

    const runResult = await pool.query(
      `INSERT INTO extraction_runs (guild_id, window_start, window_end, message_count, model)
       VALUES ('200', now(), now(), 1, 'test') RETURNING id`,
    );

    const result = await mergeEntities(pool, '200', [
      makeExtracted({ resolvesExistingId: existingId, status: 'resolved', confidence: 0.9 }),
    ], runResult.rows[0].id);

    expect(result.skipped).toBe(1);
  });

  it('skips update when resolves_existing_id references entity from different guild', async () => {
    const existingId = await insertEntity(pool, {
      guild_id: '999', type: 'action', title: 'Other guild action',
      body: null, status: 'open', confidence: 0.9,
      first_seen: new Date(), last_seen: new Date(), mentions: 1,
      metadata: {},
    });

    const runResult = await pool.query(
      `INSERT INTO extraction_runs (guild_id, window_start, window_end, message_count, model)
       VALUES ('200', now(), now(), 1, 'test') RETURNING id`,
    );

    const result = await mergeEntities(pool, '200', [
      makeExtracted({ resolvesExistingId: existingId, status: 'resolved', confidence: 0.9 }),
    ], runResult.rows[0].id);

    expect(result.skipped).toBe(1);
  });

  it('does not update status when confidence <= 0.5', async () => {
    const existingId = await insertEntity(pool, {
      guild_id: '200', type: 'action', title: 'Ambiguous action',
      body: null, status: 'open', confidence: 0.9,
      first_seen: new Date(), last_seen: new Date(), mentions: 1,
      metadata: {},
    });

    const runResult = await pool.query(
      `INSERT INTO extraction_runs (guild_id, window_start, window_end, message_count, model)
       VALUES ('200', now(), now(), 1, 'test') RETURNING id`,
    );

    await mergeEntities(pool, '200', [
      makeExtracted({ resolvesExistingId: existingId, status: 'resolved', confidence: 0.4 }),
    ], runResult.rows[0].id);

    const entity = await getEntityById(pool, existingId);
    expect(entity!.status).toBe('open'); // unchanged due to low confidence
  });

  it('deduplicates update records by resolves_existing_id within batch', async () => {
    const existingId = await insertEntity(pool, {
      guild_id: '200', type: 'action', title: 'Dedup target',
      body: null, status: 'open', confidence: 0.9,
      first_seen: new Date(), last_seen: new Date(), mentions: 1,
      metadata: {},
    });

    const runResult = await pool.query(
      `INSERT INTO extraction_runs (guild_id, window_start, window_end, message_count, model)
       VALUES ('200', now(), now(), 1, 'test') RETURNING id`,
    );

    const result = await mergeEntities(pool, '200', [
      makeExtracted({ resolvesExistingId: existingId, status: 'resolved', confidence: 0.6, evidenceMessageIds: ['a'] }),
      makeExtracted({ resolvesExistingId: existingId, status: 'resolved', confidence: 0.9, evidenceMessageIds: ['b'] }),
    ], runResult.rows[0].id);

    // Should be deduplicated to 1 update, not 2
    expect(result.updated).toBe(1);
    expect(result.created).toBe(0);
  });
});
