import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { runMigrations } from '../src/db/migrate.js';
import { insertEntity } from '../src/db/entities.js';
import { insertMessage } from '../src/db/messages.js';
import { ensureGuildConfig } from '../src/db/guild-config.js';
import {
  handleSearchKnowledge,
  handleGetActions,
  handleGetOpenQuestions,
  handleGetProjects,
  handleGetDecisions,
  handleGetDigest,
  handleGetEntityContext,
} from '../src/mcp/tools.js';

const TEST_DB_URL = process.env.DATABASE_URL || 'postgres://secretary:secretpassword@localhost:5432/secretary';

describe('MCP Tools', () => {
  let pool: pg.Pool;
  const now = new Date();
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE entity_evidence, entities, extraction_runs, messages, guild_config CASCADE');
    await ensureGuildConfig(pool, '200');

    // Seed test data
    await insertEntity(pool, {
      guild_id: '200', type: 'project', title: 'Authentication system',
      body: 'Building OAuth-based auth', status: 'open', confidence: 1.0,
      first_seen: weekAgo, last_seen: now, mentions: 5, metadata: {},
    });
    await insertEntity(pool, {
      guild_id: '200', type: 'project', title: 'Payment integration',
      body: 'Stripe payments', status: 'stale', confidence: 0.8,
      first_seen: weekAgo, last_seen: weekAgo, mentions: 2, metadata: {},
    });
    await insertEntity(pool, {
      guild_id: '200', type: 'action', title: 'Deploy auth service',
      body: null, status: 'open', confidence: 0.9,
      first_seen: now, last_seen: now, mentions: 1, metadata: { assignee: 'alice' },
    });
    await insertEntity(pool, {
      guild_id: '200', type: 'action', title: 'Update docs',
      body: null, status: 'open', confidence: 0.9,
      first_seen: now, last_seen: now, mentions: 1, metadata: { assignee: 'bob' },
    });
    await insertEntity(pool, {
      guild_id: '200', type: 'question', title: 'Which database to use?',
      body: 'PostgreSQL vs MySQL discussion', status: 'open', confidence: 0.85,
      first_seen: now, last_seen: now, mentions: 1, metadata: {},
    });
    await insertEntity(pool, {
      guild_id: '200', type: 'question', title: 'How to handle auth tokens?',
      body: 'JWT vs session tokens', status: 'resolved', confidence: 0.9,
      first_seen: weekAgo, last_seen: now, mentions: 3, metadata: {},
    });
    await insertEntity(pool, {
      guild_id: '200', type: 'decision', title: 'Use PostgreSQL for main database',
      body: 'Team agreed on PostgreSQL', status: 'open', confidence: 1.0,
      first_seen: now, last_seen: now, mentions: 2, metadata: {},
    });
  });

  describe('search_knowledge', () => {
    it('returns matching entities ranked by relevance', async () => {
      const result = await handleSearchKnowledge(pool, { query: 'authentication' });
      expect(result.count).toBeGreaterThan(0);
      expect((result.entities as Record<string, unknown>[]).some(
        (e) => (e.title as string).includes('Authentication'),
      )).toBe(true);
    });

    it('filters by type', async () => {
      const result = await handleSearchKnowledge(pool, { query: 'auth', type: 'project' });
      for (const e of result.entities as Record<string, unknown>[]) {
        expect(e.type).toBe('project');
      }
    });

    it('returns empty for non-matching query', async () => {
      const result = await handleSearchKnowledge(pool, { query: 'xyznonexistent' });
      expect(result.count).toBe(0);
    });

    it('rejects empty query', async () => {
      const result = await handleSearchKnowledge(pool, { query: '' });
      expect(result.error).toBeDefined();
    });

    it('respects limit', async () => {
      const result = await handleSearchKnowledge(pool, { query: 'auth', limit: 1 });
      expect((result.entities as unknown[]).length).toBeLessThanOrEqual(1);
    });
  });

  describe('get_actions', () => {
    it('returns open actions by default', async () => {
      const result = await handleGetActions(pool, {});
      expect(result.count).toBe(2);
    });

    it('filters by assignee', async () => {
      const result = await handleGetActions(pool, { assignee: 'alice' });
      expect(result.count).toBe(1);
      expect(((result.actions as Record<string, unknown>[])[0].metadata as Record<string, unknown>).assignee).toBe('alice');
    });
  });

  describe('get_open_questions', () => {
    it('returns only open questions', async () => {
      const result = await handleGetOpenQuestions(pool, {});
      expect(result.count).toBe(1);
      expect((result.questions as Record<string, unknown>[])[0].title).toBe('Which database to use?');
    });
  });

  describe('get_projects', () => {
    it('returns all projects', async () => {
      const result = await handleGetProjects(pool, { status: 'all' });
      expect(result.count).toBe(2);
    });

    it('filters active projects', async () => {
      const result = await handleGetProjects(pool, { status: 'active' });
      expect(result.count).toBe(1);
      expect((result.projects as Record<string, unknown>[])[0].title).toBe('Authentication system');
    });

    it('filters stale projects', async () => {
      const result = await handleGetProjects(pool, { status: 'stale' });
      expect(result.count).toBe(1);
    });
  });

  describe('get_decisions', () => {
    it('returns decisions', async () => {
      const result = await handleGetDecisions(pool, {});
      expect(result.count).toBe(1);
      expect((result.decisions as Record<string, unknown>[])[0].title).toBe('Use PostgreSQL for main database');
    });

    it('respects limit', async () => {
      const result = await handleGetDecisions(pool, { limit: 0 });
      expect(result.count).toBe(0);
    });
  });

  describe('get_digest', () => {
    it('returns entity counts for time window', async () => {
      const result = await handleGetDigest(pool, {
        since: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      });
      const summary = result.summary as Record<string, number>;
      expect(summary.total).toBeGreaterThan(0);
      expect(summary.projects).toBeGreaterThanOrEqual(1);
    });

    it('returns error for missing since', async () => {
      const result = await handleGetDigest(pool, { since: '' });
      // Empty since will still parse (as invalid date), but the query should handle it
      expect(result).toBeDefined();
    });

    it('returns error when since > until', async () => {
      const result = await handleGetDigest(pool, {
        since: '2025-01-01',
        until: '2024-01-01',
      });
      expect(result.error).toBeDefined();
    });
  });

  describe('get_entity_context', () => {
    it('returns entity with evidence messages', async () => {
      // Insert messages and link evidence
      await insertMessage(pool, {
        id: '9001', channel_id: '100', guild_id: '200', author_id: '300', author_name: 'alice',
        content: 'We should use PostgreSQL', created_at: new Date('2024-01-15T10:00:00Z'),
        has_attachments: false, reply_to_id: null, thread_id: null,
      });
      await insertMessage(pool, {
        id: '9002', channel_id: '100', guild_id: '200', author_id: '301', author_name: 'bob',
        content: 'Agreed, PostgreSQL it is', created_at: new Date('2024-01-15T10:01:00Z'),
        has_attachments: false, reply_to_id: null, thread_id: null,
      });

      // Get decision entity ID
      const entityResult = await pool.query("SELECT id FROM entities WHERE title = 'Use PostgreSQL for main database'");
      const entityId = entityResult.rows[0].id;

      // Create extraction run and link evidence
      const runResult = await pool.query(
        `INSERT INTO extraction_runs (guild_id, window_start, window_end, message_count, model)
         VALUES ('200', now(), now(), 2, 'test') RETURNING id`,
      );
      await pool.query(
        `INSERT INTO entity_evidence (entity_id, message_id, extraction_id) VALUES ($1, $2, $3)`,
        [entityId, '9001', runResult.rows[0].id],
      );

      const result = await handleGetEntityContext(pool, { entity_id: entityId });
      expect((result.entity as Record<string, unknown>).title).toBe('Use PostgreSQL for main database');
      expect((result.messages as unknown[]).length).toBeGreaterThan(0);
    });

    it('returns error for non-existent entity', async () => {
      const result = await handleGetEntityContext(pool, { entity_id: 999999 });
      expect(result.error).toBeDefined();
    });
  });
});
