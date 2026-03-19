import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { runMigrations } from '../src/db/migrate.js';
import {
  searchSimilarEntities,
  insertEntity,
  updateEntity,
  linkEvidence,
  fullTextSearch,
  markStaleEntities,
  getEntityById,
} from '../src/db/entities.js';
import { insertMessage } from '../src/db/messages.js';
import type { MessageRow } from '../src/db/messages.js';

const TEST_DB_URL = process.env.DATABASE_URL || 'postgres://secretary:secretpassword@localhost:5432/secretary';

function makeMsg(id: string): MessageRow {
  return {
    id, channel_id: '100', guild_id: '200', author_id: '300', author_name: 'user',
    content: 'test', created_at: new Date('2024-01-15T10:00:00Z'), has_attachments: false,
    reply_to_id: null, thread_id: null,
  };
}

describe('Entity DB Operations', () => {
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

  it('inserts entity and returns id', async () => {
    const id = await insertEntity(pool, {
      guild_id: '200', type: 'project', title: 'Deploy authentication service',
      body: 'Deploying the auth service', status: 'open', confidence: 0.9,
      first_seen: new Date(), last_seen: new Date(), mentions: 1, metadata: { tags: ['auth'] },
    });
    expect(id).toBeGreaterThan(0);
  });

  it('finds similar entities by title', async () => {
    await insertEntity(pool, {
      guild_id: '200', type: 'action', title: 'Deploy authentication service',
      body: null, status: 'open', confidence: 1.0,
      first_seen: new Date(), last_seen: new Date(), mentions: 1, metadata: {},
    });

    const matches = await searchSimilarEntities(pool, '200', 'action', 'auth service deployment', 0.2);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].title).toBe('Deploy authentication service');
    expect(matches[0].similarityScore).toBeGreaterThan(0.2);
  });

  it('does not match different types', async () => {
    await insertEntity(pool, {
      guild_id: '200', type: 'project', title: 'Deploy authentication service',
      body: null, status: 'open', confidence: 1.0,
      first_seen: new Date(), last_seen: new Date(), mentions: 1, metadata: {},
    });

    const matches = await searchSimilarEntities(pool, '200', 'action', 'Deploy authentication service', 0.4);
    expect(matches.length).toBe(0);
  });

  it('updates entity partially', async () => {
    const id = await insertEntity(pool, {
      guild_id: '200', type: 'question', title: 'Redis vs Memcached?',
      body: null, status: 'open', confidence: 0.8,
      first_seen: new Date(), last_seen: new Date(), mentions: 1, metadata: {},
    });

    await updateEntity(pool, id, { status: 'resolved', mentions: 3 });

    const entity = await getEntityById(pool, id);
    expect(entity!.status).toBe('resolved');
    expect(entity!.mentions).toBe(3);
  });

  it('links evidence idempotently', async () => {
    // Need a message and extraction run for FK constraints
    await insertMessage(pool, makeMsg('1001'));
    const runResult = await pool.query(
      `INSERT INTO extraction_runs (guild_id, window_start, window_end, message_count, model)
       VALUES ('200', now(), now(), 1, 'test') RETURNING id`,
    );
    const runId = runResult.rows[0].id;

    const entityId = await insertEntity(pool, {
      guild_id: '200', type: 'decision', title: 'Use PostgreSQL',
      body: null, status: 'open', confidence: 1.0,
      first_seen: new Date(), last_seen: new Date(), mentions: 1, metadata: {},
    });

    await linkEvidence(pool, entityId, '1001', runId);
    // Second link should not throw
    await linkEvidence(pool, entityId, '1001', runId);

    const evidence = await pool.query('SELECT * FROM entity_evidence WHERE entity_id = $1', [entityId]);
    expect(evidence.rows.length).toBe(1);
  });

  it('performs full-text search with type filter', async () => {
    await insertEntity(pool, {
      guild_id: '200', type: 'project', title: 'Authentication system',
      body: 'Building a new auth system with OAuth', status: 'open', confidence: 1.0,
      first_seen: new Date(), last_seen: new Date(), mentions: 1, metadata: {},
    });
    await insertEntity(pool, {
      guild_id: '200', type: 'concept', title: 'Authentication patterns',
      body: 'Discussing different auth patterns', status: 'open', confidence: 1.0,
      first_seen: new Date(), last_seen: new Date(), mentions: 1, metadata: {},
    });

    const results = await fullTextSearch(pool, '200', 'authentication', { type: 'project' });
    expect(results.length).toBe(1);
    expect(results[0].type).toBe('project');
  });

  it('marks stale entities', async () => {
    const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
    const thirteenDaysAgo = new Date(Date.now() - 13 * 24 * 60 * 60 * 1000);

    await insertEntity(pool, {
      guild_id: '200', type: 'action', title: 'Old action',
      body: null, status: 'open', confidence: 1.0,
      first_seen: fifteenDaysAgo, last_seen: fifteenDaysAgo, mentions: 1, metadata: {},
    });
    await insertEntity(pool, {
      guild_id: '200', type: 'action', title: 'Recent action',
      body: null, status: 'open', confidence: 1.0,
      first_seen: thirteenDaysAgo, last_seen: thirteenDaysAgo, mentions: 1, metadata: {},
    });
    await insertEntity(pool, {
      guild_id: '200', type: 'question', title: 'Resolved question',
      body: null, status: 'resolved', confidence: 1.0,
      first_seen: fifteenDaysAgo, last_seen: fifteenDaysAgo, mentions: 1, metadata: {},
    });

    const count = await markStaleEntities(pool, 14);
    expect(count).toBe(1); // only 'Old action' — recent is within 14 days, resolved is not 'open'

    const stale = await pool.query("SELECT title FROM entities WHERE status = 'stale'");
    expect(stale.rows[0].title).toBe('Old action');
  });
});
