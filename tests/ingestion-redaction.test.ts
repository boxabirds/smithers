import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { runMigrations } from '../src/db/migrate.js';
import { insertMessage, batchInsertMessages, updateMessageContent, type MessageRow } from '../src/db/messages.js';
import { redactContent } from '../src/redaction.js';

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

describe('Ingestion Redaction Integration', () => {
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

  it('stores redacted email in database via insertMessage', async () => {
    const raw = 'please email alice@example.com for details';
    const redacted = await redactContent(raw);

    await insertMessage(pool, makeRow('900001', { content: redacted }));

    const result = await pool.query('SELECT content FROM messages WHERE id = $1', ['900001']);
    expect(result.rows[0].content).not.toContain('alice@example.com');
    expect(result.rows[0].content).toContain('[REDACTED]');
  });

  it('stores redacted phone number in database via insertMessage', async () => {
    const raw = 'call 555-867-5309 for support';
    const redacted = await redactContent(raw);

    await insertMessage(pool, makeRow('900002', { content: redacted }));

    const result = await pool.query('SELECT content FROM messages WHERE id = $1', ['900002']);
    expect(result.rows[0].content).not.toContain('555-867-5309');
    expect(result.rows[0].content).toContain('[REDACTED]');
  });

  it('stores redacted content via updateMessageContent', async () => {
    // Insert original message (already redacted)
    await insertMessage(pool, makeRow('900003', { content: 'hello' }));

    // Simulate message edit with PII
    const newContent = 'my new email is bob@corp.net';
    const redacted = await redactContent(newContent);
    await updateMessageContent(pool, '900003', redacted);

    const result = await pool.query('SELECT content FROM messages WHERE id = $1', ['900003']);
    expect(result.rows[0].content).not.toContain('bob@corp.net');
    expect(result.rows[0].content).toContain('[REDACTED]');
  });

  it('stores redacted content via batchInsertMessages', async () => {
    const messages = [
      makeRow('900010', { content: await redactContent('contact user@test.com') }),
      makeRow('900011', { content: await redactContent('server at 10.0.0.5') }),
      makeRow('900012', { content: await redactContent('no PII here') }),
    ];

    await batchInsertMessages(pool, messages);

    const result = await pool.query(
      'SELECT id, content FROM messages WHERE id IN ($1, $2, $3) ORDER BY id',
      ['900010', '900011', '900012'],
    );

    expect(result.rows[0].content).not.toContain('user@test.com');
    expect(result.rows[0].content).toContain('[REDACTED]');
    expect(result.rows[1].content).not.toContain('10.0.0.5');
    expect(result.rows[1].content).toContain('[REDACTED]');
    expect(result.rows[2].content).toBe('no PII here');
  });

  it('extraction pipeline reads redacted content from database', async () => {
    const raw = 'action: send contract to alice@example.com by Friday';
    const redacted = await redactContent(raw);
    await insertMessage(pool, makeRow('900020', { content: redacted }));

    // Simulate what the scheduler does: SELECT messages for extraction
    const result = await pool.query(
      `SELECT id, author_name, content, created_at FROM messages WHERE id = $1 AND deleted_at IS NULL`,
      ['900020'],
    );

    const msg = result.rows[0];
    expect(msg.content).not.toContain('alice@example.com');
    expect(msg.content).toContain('[REDACTED]');
    // The formatted prompt input would use this redacted content
    const promptLine = `${msg.author_name} (${msg.created_at.toISOString()}): ${msg.content}`;
    expect(promptLine).not.toContain('alice@example.com');
  });
});
