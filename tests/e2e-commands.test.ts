import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import { runMigrations } from '../src/db/migrate.js';
import { insertEntity, getEntityById } from '../src/db/entities.js';
import { ensureGuildConfig } from '../src/db/guild-config.js';
import { handleSlashCommand } from '../src/bot/commands/index.js';
import { buildCommandDefinitions } from '../src/bot/commands/register.js';
import type { ChatInputCommandInteraction } from 'discord.js';

const TEST_DB_URL = process.env.DATABASE_URL || 'postgres://secretary:secretpassword@localhost:5432/secretary';
const TEST_GUILD_ID = '200';
const TEST_USER_ID = '12345';
const BOT_START_TIME = new Date(Date.now() - 3_600_000);

/**
 * Mock interaction harness for e2e testing slash commands.
 * Simulates the full Discord interaction lifecycle through the router.
 */
function mockInteraction(
  commandName: string,
  options: Record<string, unknown> = {},
  subcommand?: string,
): {
  interaction: ChatInputCommandInteraction;
  getEditReplyArg: () => Record<string, unknown> | null;
  getReplyArg: () => Record<string, unknown> | null;
} {
  let editReplyArg: Record<string, unknown> | null = null;
  let replyArg: Record<string, unknown> | null = null;

  const interaction = {
    commandName,
    guildId: TEST_GUILD_ID,
    deferred: false,
    user: { id: TEST_USER_ID },
    options: {
      getString: (name: string) => options[name] as string | null ?? null,
      getInteger: (name: string) => options[name] as number | null ?? null,
      getSubcommand: () => subcommand ?? null,
    },
    deferReply: vi.fn(async () => {
      (interaction as unknown as Record<string, boolean>).deferred = true;
    }),
    editReply: vi.fn(async (arg: Record<string, unknown>) => {
      editReplyArg = arg;
    }),
    reply: vi.fn(async (arg: Record<string, unknown>) => {
      replyArg = arg;
    }),
    isChatInputCommand: () => true,
  } as unknown as ChatInputCommandInteraction;

  return {
    interaction,
    getEditReplyArg: () => editReplyArg,
    getReplyArg: () => replyArg,
  };
}

function getEmbedJson(arg: Record<string, unknown>): Record<string, unknown> {
  return (arg.embeds as { toJSON: () => Record<string, unknown> }[])[0].toJSON();
}

describe('E2E Slash Commands via Mock Interaction Harness', () => {
  let pool: pg.Pool;
  const now = new Date();

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE entity_corrections, entity_evidence, entities, extraction_runs, messages, guild_config CASCADE');
    await ensureGuildConfig(pool, TEST_GUILD_ID);
  });

  async function seedEntity(overrides: Partial<{
    type: string; title: string; body: string | null; status: string;
    confidence: number; mentions: number;
  }> = {}): Promise<number> {
    return insertEntity(pool, {
      guild_id: TEST_GUILD_ID,
      type: overrides.type ?? 'action',
      title: overrides.title ?? 'Test entity',
      body: overrides.body ?? null,
      status: overrides.status ?? 'open',
      confidence: overrides.confidence ?? 0.9,
      first_seen: now, last_seen: now,
      mentions: overrides.mentions ?? 1,
      metadata: {},
    });
  }

  describe('Command Registration', () => {
    it('defines 8 commands including search and correct', () => {
      const commands = buildCommandDefinitions();
      expect(commands).toHaveLength(8);
      const names = commands.map((c) => c.name);
      expect(names).toContain('search');
      expect(names).toContain('correct');
    });

    it('/correct has 5 subcommands', () => {
      const commands = buildCommandDefinitions();
      const correct = commands.find((c) => c.name === 'correct')!;
      const json = correct.toJSON();
      expect(json.options).toHaveLength(5);
      const subNames = json.options!.map((o: Record<string, unknown>) => o.name);
      expect(subNames).toContain('retype');
      expect(subNames).toContain('retitle');
      expect(subNames).toContain('resolve');
      expect(subNames).toContain('delete');
      expect(subNames).toContain('merge');
    });
  });

  describe('/search e2e', () => {
    it('routes through full pipeline and returns matching entities', async () => {
      await seedEntity({ type: 'project', title: 'Authentication system', body: 'OAuth-based auth' });
      await seedEntity({ type: 'action', title: 'Deploy auth service' });

      const { interaction, getEditReplyArg } = mockInteraction('search', { query: 'auth' });
      await handleSlashCommand(interaction, pool, BOT_START_TIME);

      expect(interaction.deferReply).toHaveBeenCalled();
      const arg = getEditReplyArg()!;
      expect(arg.embeds).toHaveLength(1);
      const embed = getEmbedJson(arg);
      expect(embed.description).toContain('Authentication system');
    });

    it('shows empty state when no results match', async () => {
      const { interaction, getEditReplyArg } = mockInteraction('search', { query: 'nonexistent' });
      await handleSlashCommand(interaction, pool, BOT_START_TIME);

      const embed = getEmbedJson(getEditReplyArg()!);
      expect(embed.description).toContain('No entities found');
    });
  });

  describe('/correct retype e2e', () => {
    it('retypes entity through full pipeline', async () => {
      const id = await seedEntity({ type: 'decision', title: 'Deploy the service' });

      const { interaction, getEditReplyArg } = mockInteraction('correct', { entity_id: id, new_type: 'action' }, 'retype');
      await handleSlashCommand(interaction, pool, BOT_START_TIME);

      expect(interaction.deferReply).toHaveBeenCalled();
      const embed = getEmbedJson(getEditReplyArg()!);
      expect(embed.description).toContain('action');

      // Verify DB was updated
      const entity = await getEntityById(pool, id);
      expect(entity!.type).toBe('action');

      // Verify correction was logged
      const log = await pool.query('SELECT * FROM entity_corrections WHERE entity_id = $1', [id]);
      expect(log.rows.length).toBe(1);
      expect(log.rows[0].operation).toBe('retype');
    });

    it('returns error for invalid entity type', async () => {
      const id = await seedEntity();

      const { interaction, getEditReplyArg } = mockInteraction('correct', { entity_id: id, new_type: 'banana' }, 'retype');
      await handleSlashCommand(interaction, pool, BOT_START_TIME);

      const embed = getEmbedJson(getEditReplyArg()!);
      expect(embed.description).toContain('Invalid');
    });

    it('returns error for non-existent entity', async () => {
      const { interaction, getEditReplyArg } = mockInteraction('correct', { entity_id: 999999, new_type: 'action' }, 'retype');
      await handleSlashCommand(interaction, pool, BOT_START_TIME);

      const embed = getEmbedJson(getEditReplyArg()!);
      expect(embed.description).toContain('not found');
    });
  });

  describe('/correct merge e2e', () => {
    it('merges source into target through full pipeline', async () => {
      const sourceId = await seedEntity({ type: 'action', title: 'Deploy auth', mentions: 3 });
      const targetId = await seedEntity({ type: 'action', title: 'Deploy authentication service', mentions: 5 });

      const { interaction, getEditReplyArg } = mockInteraction(
        'correct', { entity_id: sourceId, into_entity_id: targetId }, 'merge',
      );
      await handleSlashCommand(interaction, pool, BOT_START_TIME);

      const embed = getEmbedJson(getEditReplyArg()!);
      expect(embed.description).toContain('Merged');

      // Source should be soft-deleted
      const source = await getEntityById(pool, sourceId, true);
      expect(source!.deleted_at).not.toBeNull();

      // Target should have combined mentions
      const target = await getEntityById(pool, targetId);
      expect(target!.mentions).toBe(8);
    });
  });

  describe('/correct delete e2e', () => {
    it('soft-deletes entity through full pipeline', async () => {
      const id = await seedEntity({ title: 'Bad extraction' });

      const { interaction, getEditReplyArg } = mockInteraction('correct', { entity_id: id }, 'delete');
      await handleSlashCommand(interaction, pool, BOT_START_TIME);

      const embed = getEmbedJson(getEditReplyArg()!);
      expect(embed.description).toContain('delete');

      // Entity should be soft-deleted
      const entity = await getEntityById(pool, id);
      expect(entity).toBeNull(); // excluded by default
      const withDeleted = await getEntityById(pool, id, true);
      expect(withDeleted!.deleted_at).not.toBeNull();
    });

    it('returns error for non-existent entity', async () => {
      const { interaction, getEditReplyArg } = mockInteraction('correct', { entity_id: 999999 }, 'delete');
      await handleSlashCommand(interaction, pool, BOT_START_TIME);

      const embed = getEmbedJson(getEditReplyArg()!);
      expect(embed.description).toContain('not found');
    });
  });

  describe('/correct resolve e2e', () => {
    it('resolves entity through full pipeline', async () => {
      const id = await seedEntity({ status: 'open', title: 'Open question' });

      const { interaction, getEditReplyArg } = mockInteraction('correct', { entity_id: id }, 'resolve');
      await handleSlashCommand(interaction, pool, BOT_START_TIME);

      const embed = getEmbedJson(getEditReplyArg()!);
      expect(embed.description).toContain('resolve');

      const entity = await getEntityById(pool, id);
      expect(entity!.status).toBe('resolved');
    });
  });

  describe('/correct retitle e2e', () => {
    it('retitles entity through full pipeline', async () => {
      const id = await seedEntity({ title: 'Bad title' });

      const { interaction, getEditReplyArg } = mockInteraction('correct', { entity_id: id, new_title: 'Better title' }, 'retitle');
      await handleSlashCommand(interaction, pool, BOT_START_TIME);

      const embed = getEmbedJson(getEditReplyArg()!);
      expect(embed.description).toContain('Better title');

      const entity = await getEntityById(pool, id);
      expect(entity!.title).toBe('Better title');
    });
  });
});
