import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { runMigrations } from '../src/db/migrate.js';
import { insertMessage, updateMessageContent, softDeleteMessage, batchInsertMessages, type MessageRow } from '../src/db/messages.js';

const TEST_DB_URL = process.env.DATABASE_URL || 'postgres://secretary:secretpassword@localhost:5432/secretary';

function makeRow(id: string, overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id,
    channel_id: '100',
    guild_id: '200',
    author_id: '300',
    author_name: 'testuser',
    content: `Message ${id}`,
    created_at: new Date('2024-01-15T10:00:00Z'),
    has_attachments: false,
    reply_to_id: null,
    thread_id: null,
    ...overrides,
  };
}

describe('Message DB Operations', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE entity_evidence, messages CASCADE');
  });

  it('inserts a message with all fields', async () => {
    await insertMessage(pool, makeRow('1', { reply_to_id: '99', thread_id: '88', has_attachments: true }));
    const result = await pool.query('SELECT * FROM messages WHERE id = $1', ['1']);
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].author_name).toBe('testuser');
    expect(result.rows[0].reply_to_id).toBe('99');
    expect(result.rows[0].thread_id).toBe('88');
    expect(result.rows[0].has_attachments).toBe(true);
  });

  it('handles duplicate insert with ON CONFLICT', async () => {
    await insertMessage(pool, makeRow('2'));
    await insertMessage(pool, makeRow('2', { content: 'updated' }));
    const result = await pool.query('SELECT content FROM messages WHERE id = $1', ['2']);
    expect(result.rows[0].content).toBe('Message 2'); // original, not updated
  });

  it('batch inserts messages and reports count', async () => {
    const msgs = Array.from({ length: 100 }, (_, i) => makeRow(String(1000 + i)));
    const inserted = await batchInsertMessages(pool, msgs);
    expect(inserted).toBe(100);

    const count = await pool.query('SELECT count(*) as n FROM messages');
    expect(Number(count.rows[0].n)).toBe(100);
  });

  it('batch insert with duplicates inserts only new ones', async () => {
    await insertMessage(pool, makeRow('5000'));
    await insertMessage(pool, makeRow('5001'));

    const msgs = Array.from({ length: 10 }, (_, i) => makeRow(String(5000 + i)));
    const inserted = await batchInsertMessages(pool, msgs);
    expect(inserted).toBe(8); // 10 - 2 duplicates
  });

  it('batch insert with empty array returns 0', async () => {
    const inserted = await batchInsertMessages(pool, []);
    expect(inserted).toBe(0);
  });

  it('updates message content', async () => {
    await insertMessage(pool, makeRow('3'));
    const updated = await updateMessageContent(pool, '3', 'new content');
    expect(updated).toBe(true);

    const result = await pool.query('SELECT content FROM messages WHERE id = $1', ['3']);
    expect(result.rows[0].content).toBe('new content');
  });

  it('update returns false for non-existent message', async () => {
    const updated = await updateMessageContent(pool, '999999', 'nope');
    expect(updated).toBe(false);
  });

  it('soft-deletes a message', async () => {
    await insertMessage(pool, makeRow('4'));
    const deleted = await softDeleteMessage(pool, '4');
    expect(deleted).toBe(true);

    const result = await pool.query('SELECT deleted_at FROM messages WHERE id = $1', ['4']);
    expect(result.rows[0].deleted_at).not.toBeNull();
  });

  it('soft-delete is idempotent', async () => {
    await insertMessage(pool, makeRow('5'));
    await softDeleteMessage(pool, '5');
    const secondDelete = await softDeleteMessage(pool, '5');
    expect(secondDelete).toBe(false); // already deleted
  });

  it('soft-delete returns false for non-existent message', async () => {
    const deleted = await softDeleteMessage(pool, '999998');
    expect(deleted).toBe(false);
  });
});
