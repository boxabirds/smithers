import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { runMigrations } from '../src/db/migrate.js';
import { loadGuildConfig, ensureGuildConfig } from '../src/db/guild-config.js';

const TEST_DB_URL = process.env.DATABASE_URL || 'postgres://secretary:secretpassword@localhost:5432/secretary';

describe('Guild Config Operations', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM guild_config');
  });

  it('loadGuildConfig returns null for non-existent guild', async () => {
    const config = await loadGuildConfig(pool, '999');
    expect(config).toBeNull();
  });

  it('ensureGuildConfig creates row with defaults', async () => {
    const config = await ensureGuildConfig(pool, '100');
    expect(config.guildId).toBe('100');
    expect(config.watchedChannels).toBeNull();
    expect(config.extractionIntervalMins).toBe(60);
    expect(config.timezone).toBe('UTC');
    expect(config.promptOverrides).toEqual({});
  });

  it('ensureGuildConfig returns existing without modifying', async () => {
    await pool.query(
      `INSERT INTO guild_config (guild_id, watched_channels, extraction_interval_mins) VALUES ($1, $2, $3)`,
      ['200', [1, 2, 3], 30],
    );

    const config = await ensureGuildConfig(pool, '200');
    expect(config.extractionIntervalMins).toBe(30);
    expect(config.watchedChannels).toEqual(['1', '2', '3']);
  });

  it('loadGuildConfig returns existing config', async () => {
    await ensureGuildConfig(pool, '300');
    const config = await loadGuildConfig(pool, '300');
    expect(config).not.toBeNull();
    expect(config!.guildId).toBe('300');
  });
});
