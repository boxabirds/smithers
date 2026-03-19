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
});
