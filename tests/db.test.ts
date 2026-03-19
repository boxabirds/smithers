import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { runMigrations } from '../src/db/migrate.js';

const TEST_DB_URL = process.env.DATABASE_URL || 'postgres://secretary:secretpassword@localhost:5432/secretary';

describe('Database', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('connects and runs a query', async () => {
    const result = await pool.query('SELECT 1 AS n');
    expect(result.rows[0].n).toBe(1);
  });

  it('runs migrations successfully', async () => {
    const result = await runMigrations(pool);
    // Either applies fresh (on empty DB) or skips (already applied)
    expect(result.total).toBe(1);
  });

  it('creates all expected tables', async () => {
    const result = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    const tables = result.rows.map((r: { table_name: string }) => r.table_name);
    expect(tables).toContain('messages');
    expect(tables).toContain('extraction_runs');
    expect(tables).toContain('entities');
    expect(tables).toContain('entity_evidence');
    expect(tables).toContain('guild_config');
    expect(tables).toContain('schema_migrations');
  });

  it('runs migrations idempotently', async () => {
    const result = await runMigrations(pool);
    expect(result.applied.length).toBe(0);
    expect(result.total).toBe(1);
  });

  it('has pg_trgm extension enabled', async () => {
    const result = await pool.query("SELECT similarity('hello', 'helo') AS score");
    expect(result.rows[0].score).toBeGreaterThan(0);
  });

  it('has messages table with correct columns', async () => {
    const result = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'messages'
      ORDER BY ordinal_position
    `);
    const cols = result.rows.map((r: { column_name: string }) => r.column_name);
    expect(cols).toContain('id');
    expect(cols).toContain('channel_id');
    expect(cols).toContain('guild_id');
    expect(cols).toContain('author_id');
    expect(cols).toContain('author_name');
    expect(cols).toContain('content');
    expect(cols).toContain('created_at');
    expect(cols).toContain('deleted_at');
    expect(cols).toContain('thread_id');
    expect(cols).toContain('reply_to_id');
  });

  it('has entities table with correct columns', async () => {
    const result = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'entities'
      ORDER BY ordinal_position
    `);
    const cols = result.rows.map((r: { column_name: string }) => r.column_name);
    expect(cols).toContain('id');
    expect(cols).toContain('guild_id');
    expect(cols).toContain('type');
    expect(cols).toContain('title');
    expect(cols).toContain('body');
    expect(cols).toContain('status');
    expect(cols).toContain('confidence');
    expect(cols).toContain('metadata');
  });
});
