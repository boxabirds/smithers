import type pg from 'pg';

export interface GuildConfig {
  guildId: string;
  watchedChannels: string[] | null;
  extractionIntervalMins: number;
  timezone: string;
  promptOverrides: Record<string, unknown>;
}

function rowToGuildConfig(row: Record<string, unknown>): GuildConfig {
  const watchedRaw = row.watched_channels as string[] | null;
  return {
    guildId: String(row.guild_id),
    watchedChannels: watchedRaw ? watchedRaw.map(String) : null,
    extractionIntervalMins: row.extraction_interval_mins as number,
    timezone: row.timezone as string,
    promptOverrides: (row.prompt_overrides as Record<string, unknown>) ?? {},
  };
}

export async function loadGuildConfig(pool: pg.Pool, guildId: string): Promise<GuildConfig | null> {
  const result = await pool.query('SELECT * FROM guild_config WHERE guild_id = $1', [guildId]);
  if (result.rows.length === 0) return null;
  return rowToGuildConfig(result.rows[0]);
}

export async function ensureGuildConfig(pool: pg.Pool, guildId: string): Promise<GuildConfig> {
  await pool.query(
    `INSERT INTO guild_config (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING`,
    [guildId],
  );
  const result = await pool.query('SELECT * FROM guild_config WHERE guild_id = $1', [guildId]);
  return rowToGuildConfig(result.rows[0]);
}
