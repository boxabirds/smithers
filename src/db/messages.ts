import type pg from 'pg';

export interface MessageRow {
  id: string;
  channel_id: string;
  guild_id: string;
  author_id: string;
  author_name: string;
  content: string;
  created_at: Date;
  has_attachments: boolean;
  reply_to_id: string | null;
  thread_id: string | null;
}

export async function insertMessage(pool: pg.Pool, msg: MessageRow): Promise<void> {
  await pool.query(
    `INSERT INTO messages (id, channel_id, guild_id, author_id, author_name, content, created_at, has_attachments, reply_to_id, thread_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (id) DO NOTHING`,
    [msg.id, msg.channel_id, msg.guild_id, msg.author_id, msg.author_name, msg.content, msg.created_at, msg.has_attachments, msg.reply_to_id, msg.thread_id],
  );
}

export async function updateMessageContent(pool: pg.Pool, id: string, content: string): Promise<boolean> {
  const result = await pool.query(
    'UPDATE messages SET content = $1 WHERE id = $2',
    [content, id],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function softDeleteMessage(pool: pg.Pool, id: string): Promise<boolean> {
  const result = await pool.query(
    'UPDATE messages SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL',
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function batchInsertMessages(pool: pg.Pool, msgs: MessageRow[]): Promise<number> {
  if (msgs.length === 0) return 0;

  const values: unknown[] = [];
  const placeholders: string[] = [];

  const COLS_PER_ROW = 10;

  for (let i = 0; i < msgs.length; i++) {
    const offset = i * COLS_PER_ROW;
    placeholders.push(
      `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10})`,
    );
    const m = msgs[i];
    values.push(m.id, m.channel_id, m.guild_id, m.author_id, m.author_name, m.content, m.created_at, m.has_attachments, m.reply_to_id, m.thread_id);
  }

  const result = await pool.query(
    `INSERT INTO messages (id, channel_id, guild_id, author_id, author_name, content, created_at, has_attachments, reply_to_id, thread_id)
     VALUES ${placeholders.join(', ')}
     ON CONFLICT (id) DO NOTHING`,
    values,
  );

  return result.rowCount ?? 0;
}
