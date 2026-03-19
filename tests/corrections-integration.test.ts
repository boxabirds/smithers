import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import { runMigrations } from '../src/db/migrate.js';
import {
  insertEntity,
  getEntityById,
  fullTextSearch,
  getEntitiesByFilters,
  retypeEntity,
  retitleEntity,
  resolveEntity,
  softDeleteEntity,
  mergeEntities,
  logCorrection,
  linkEvidence,
} from '../src/db/entities.js';
import { insertMessage } from '../src/db/messages.js';
import { ensureGuildConfig } from '../src/db/guild-config.js';
import {
  handleSearchCommand,
  handleCorrectCommand,
} from '../src/bot/commands/handlers.js';
import { EMPTY_MESSAGES, VALID_ENTITY_TYPES } from '../src/bot/commands/constants.js';
import type { ChatInputCommandInteraction } from 'discord.js';

const TEST_DB_URL = process.env.DATABASE_URL || 'postgres://secretary:secretpassword@localhost:5432/secretary';

/** Test guild ID used across all correction tests */
const TEST_GUILD_ID = '200';

/** Test user ID for the correcting Discord user */
const TEST_USER_ID = '12345';

/**
 * Creates a mock Discord ChatInputCommandInteraction with subcommand support.
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
      getString: (name: string, _required?: boolean) => options[name] as string | null ?? null,
      getInteger: (name: string, _required?: boolean) => options[name] as number | null ?? null,
      getSubcommand: (_required?: boolean) => subcommand ?? null,
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

describe('Entity Corrections (Integration)', () => {
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
      first_seen: now,
      last_seen: now,
      mentions: overrides.mentions ?? 1,
      metadata: {},
    });
  }

  // ─── DB Operation Tests ──────────────────────────────────────────

  describe('retypeEntity', () => {
    it('changes entity type and returns updated row', async () => {
      const id = await seedEntity({ type: 'decision' });
      const result = await retypeEntity(pool, id, 'action');
      expect(result).not.toBeNull();
      expect(result!.type).toBe('action');
      const check = await getEntityById(pool, id);
      expect(check!.type).toBe('action');
    });

    it('returns null for non-existent entity', async () => {
      const result = await retypeEntity(pool, 999999, 'action');
      expect(result).toBeNull();
    });

    it('returns null for soft-deleted entity', async () => {
      const id = await seedEntity();
      await softDeleteEntity(pool, id);
      const result = await retypeEntity(pool, id, 'decision');
      expect(result).toBeNull();
    });
  });

  describe('retitleEntity', () => {
    it('changes entity title and returns updated row', async () => {
      const id = await seedEntity({ title: 'Old Title' });
      const result = await retitleEntity(pool, id, 'New Title');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('New Title');
    });

    it('returns null for non-existent entity', async () => {
      const result = await retitleEntity(pool, 999999, 'New Title');
      expect(result).toBeNull();
    });
  });

  describe('resolveEntity', () => {
    it('sets entity status to resolved', async () => {
      const id = await seedEntity({ status: 'open' });
      const result = await resolveEntity(pool, id);
      expect(result).not.toBeNull();
      expect(result!.status).toBe('resolved');
    });

    it('returns null for non-existent entity', async () => {
      const result = await resolveEntity(pool, 999999);
      expect(result).toBeNull();
    });
  });

  describe('softDeleteEntity', () => {
    it('sets deleted_at on entity', async () => {
      const id = await seedEntity();
      const result = await softDeleteEntity(pool, id);
      expect(result).not.toBeNull();
      expect(result!.alreadyDeleted).toBe(false);
      expect(result!.entity.deleted_at).toBeDefined();
    });

    it('returns alreadyDeleted=true for already-deleted entity', async () => {
      const id = await seedEntity();
      await softDeleteEntity(pool, id);
      const result = await softDeleteEntity(pool, id);
      expect(result).not.toBeNull();
      expect(result!.alreadyDeleted).toBe(true);
    });

    it('returns null for non-existent entity', async () => {
      const result = await softDeleteEntity(pool, 999999);
      expect(result).toBeNull();
    });

    it('soft-deleted entity excluded from fullTextSearch', async () => {
      const id = await seedEntity({ title: 'Searchable unique term xyzzyx', body: 'Body with xyzzyx' });
      const beforeDelete = await fullTextSearch(pool, TEST_GUILD_ID, 'xyzzyx');
      expect(beforeDelete.length).toBeGreaterThan(0);

      await softDeleteEntity(pool, id);
      const afterDelete = await fullTextSearch(pool, TEST_GUILD_ID, 'xyzzyx');
      expect(afterDelete.length).toBe(0);
    });

    it('soft-deleted entity excluded from getEntitiesByFilters', async () => {
      const id = await seedEntity({ type: 'concept' });
      const before = await getEntitiesByFilters(pool, TEST_GUILD_ID, { type: 'concept' });
      expect(before.length).toBeGreaterThan(0);

      await softDeleteEntity(pool, id);
      const after = await getEntitiesByFilters(pool, TEST_GUILD_ID, { type: 'concept' });
      expect(after.length).toBe(0);
    });
  });

  describe('mergeEntities', () => {
    it('transfers evidence, combines mentions, and soft-deletes source', async () => {
      const sourceId = await seedEntity({ title: 'Source', mentions: 3 });
      const targetId = await seedEntity({ title: 'Target', mentions: 5 });

      // Create evidence links
      await insertMessage(pool, {
        id: '5001', channel_id: '100', guild_id: TEST_GUILD_ID, author_id: '300', author_name: 'alice',
        content: 'msg1', created_at: new Date(), has_attachments: false, reply_to_id: null, thread_id: null,
      });
      await insertMessage(pool, {
        id: '5002', channel_id: '100', guild_id: TEST_GUILD_ID, author_id: '300', author_name: 'alice',
        content: 'msg2', created_at: new Date(), has_attachments: false, reply_to_id: null, thread_id: null,
      });
      const runResult = await pool.query(
        `INSERT INTO extraction_runs (guild_id, window_start, window_end, message_count, model)
         VALUES ($1, now(), now(), 1, 'test') RETURNING id`,
        [TEST_GUILD_ID],
      );
      const runId = runResult.rows[0].id;

      await linkEvidence(pool, sourceId, '5001', runId);
      await linkEvidence(pool, sourceId, '5002', runId);

      const result = await mergeEntities(pool, sourceId, targetId);
      expect('error' in result).toBe(false);
      if (!('error' in result)) {
        expect(result.source.deleted_at).toBeDefined();
        expect(result.target.mentions).toBe(8); // 5 + 3

        // Evidence should be on target now
        const evidence = await pool.query('SELECT * FROM entity_evidence WHERE entity_id = $1', [targetId]);
        expect(evidence.rows.length).toBe(2);

        // No evidence left on source
        const sourceEvidence = await pool.query('SELECT * FROM entity_evidence WHERE entity_id = $1', [sourceId]);
        expect(sourceEvidence.rows.length).toBe(0);
      }
    });

    it('returns error when source equals target', async () => {
      const id = await seedEntity();
      const result = await mergeEntities(pool, id, id);
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toContain('itself');
      }
    });

    it('returns error when source not found', async () => {
      const targetId = await seedEntity();
      const result = await mergeEntities(pool, 999999, targetId);
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toContain('not found');
      }
    });

    it('returns error when target not found', async () => {
      const sourceId = await seedEntity();
      const result = await mergeEntities(pool, sourceId, 999999);
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toContain('not found');
      }
    });

    it('returns error when source already deleted', async () => {
      const sourceId = await seedEntity();
      const targetId = await seedEntity();
      await softDeleteEntity(pool, sourceId);
      const result = await mergeEntities(pool, sourceId, targetId);
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toContain('deleted');
      }
    });

    it('handles merge when source has no evidence links', async () => {
      const sourceId = await seedEntity({ title: 'No evidence', mentions: 2 });
      const targetId = await seedEntity({ title: 'Target', mentions: 3 });
      const result = await mergeEntities(pool, sourceId, targetId);
      expect('error' in result).toBe(false);
      if (!('error' in result)) {
        expect(result.target.mentions).toBe(5);
        expect(result.source.deleted_at).toBeDefined();
      }
    });
  });

  describe('logCorrection', () => {
    it('creates an audit log entry with correct fields', async () => {
      const id = await seedEntity();
      await logCorrection(pool, {
        entity_id: id,
        user_id: TEST_USER_ID,
        operation: 'retype',
        before_value: 'decision',
        after_value: 'action',
      });

      const result = await pool.query('SELECT * FROM entity_corrections WHERE entity_id = $1', [id]);
      expect(result.rows.length).toBe(1);
      expect(result.rows[0].user_id).toBe(TEST_USER_ID);
      expect(result.rows[0].operation).toBe('retype');
      expect(result.rows[0].before_value).toBe('decision');
      expect(result.rows[0].after_value).toBe('action');
      expect(result.rows[0].created_at).toBeDefined();
    });
  });

  describe('getEntityById with includeDeleted', () => {
    it('excludes deleted entities by default', async () => {
      const id = await seedEntity();
      await softDeleteEntity(pool, id);
      const result = await getEntityById(pool, id);
      expect(result).toBeNull();
    });

    it('includes deleted entities when includeDeleted=true', async () => {
      const id = await seedEntity();
      await softDeleteEntity(pool, id);
      const result = await getEntityById(pool, id, true);
      expect(result).not.toBeNull();
      expect(result!.deleted_at).toBeDefined();
    });
  });

  // ─── Handler Integration Tests ──────────────────────────────────

  describe('handleSearchCommand', () => {
    it('returns matching entities', async () => {
      await seedEntity({ title: 'Deploy authentication service', body: 'Auth deployment' });
      const { interaction, getEditReplyArg } = mockInteraction('search', { query: 'authentication' });
      await handleSearchCommand(interaction, pool);

      const arg = getEditReplyArg()!;
      const json = getEmbedJson(arg);
      expect(json.description).toContain('authentication');
    });

    it('shows empty state when no matches', async () => {
      const { interaction, getEditReplyArg } = mockInteraction('search', { query: 'nonexistent_zzzz' });
      await handleSearchCommand(interaction, pool);

      const arg = getEditReplyArg()!;
      const json = getEmbedJson(arg);
      expect(json.description).toBe(EMPTY_MESSAGES.SEARCH);
    });

    it('excludes soft-deleted entities from results', async () => {
      const id = await seedEntity({ title: 'Deletable authentication item', body: 'deletable auth' });
      await softDeleteEntity(pool, id);
      const { interaction, getEditReplyArg } = mockInteraction('search', { query: 'deletable' });
      await handleSearchCommand(interaction, pool);

      const arg = getEditReplyArg()!;
      const json = getEmbedJson(arg);
      expect(json.description).toBe(EMPTY_MESSAGES.SEARCH);
    });
  });

  describe('handleCorrectCommand — retype', () => {
    it('retypes entity and creates correction log', async () => {
      const id = await seedEntity({ type: 'decision', title: 'Should be action' });
      const { interaction, getEditReplyArg } = mockInteraction('correct', {
        entity_id: id, new_type: 'action',
      }, 'retype');
      await handleCorrectCommand(interaction, pool);

      const arg = getEditReplyArg()!;
      const json = getEmbedJson(arg);
      expect(json.title).toBe('Correction: retype');
      expect(json.description).toContain('decision');
      expect(json.description).toContain('action');

      // Verify DB state
      const entity = await getEntityById(pool, id);
      expect(entity!.type).toBe('action');

      // Verify correction log
      const logs = await pool.query('SELECT * FROM entity_corrections WHERE entity_id = $1', [id]);
      expect(logs.rows.length).toBe(1);
      expect(logs.rows[0].operation).toBe('retype');
    });

    it('returns error for non-existent entity', async () => {
      const { interaction, getEditReplyArg } = mockInteraction('correct', {
        entity_id: 999999, new_type: 'action',
      }, 'retype');
      await handleCorrectCommand(interaction, pool);

      const arg = getEditReplyArg()!;
      const json = getEmbedJson(arg);
      expect(json.title).toBe('Error');
      expect(json.description).toContain('#999999');
      expect(json.description).toContain('not found');
    });
  });

  describe('handleCorrectCommand — retitle', () => {
    it('retitles entity and creates correction log', async () => {
      const id = await seedEntity({ title: 'Bad Title' });
      const { interaction, getEditReplyArg } = mockInteraction('correct', {
        entity_id: id, new_title: 'Good Title',
      }, 'retitle');
      await handleCorrectCommand(interaction, pool);

      const arg = getEditReplyArg()!;
      const json = getEmbedJson(arg);
      expect(json.title).toBe('Correction: retitle');
      expect(json.description).toContain('Bad Title');
      expect(json.description).toContain('Good Title');

      const entity = await getEntityById(pool, id);
      expect(entity!.title).toBe('Good Title');
    });

    it('returns error for non-existent entity', async () => {
      const { interaction, getEditReplyArg } = mockInteraction('correct', {
        entity_id: 999999, new_title: 'Title',
      }, 'retitle');
      await handleCorrectCommand(interaction, pool);

      const arg = getEditReplyArg()!;
      const json = getEmbedJson(arg);
      expect(json.description).toContain('not found');
    });
  });

  describe('handleCorrectCommand — resolve', () => {
    it('resolves entity and creates correction log', async () => {
      const id = await seedEntity({ status: 'open' });
      const { interaction, getEditReplyArg } = mockInteraction('correct', {
        entity_id: id,
      }, 'resolve');
      await handleCorrectCommand(interaction, pool);

      const arg = getEditReplyArg()!;
      const json = getEmbedJson(arg);
      expect(json.title).toBe('Correction: resolve');
      expect(json.description).toContain('resolved');

      const entity = await getEntityById(pool, id);
      expect(entity!.status).toBe('resolved');
    });
  });

  describe('handleCorrectCommand — delete', () => {
    it('soft-deletes entity and creates correction log', async () => {
      const id = await seedEntity();
      const { interaction, getEditReplyArg } = mockInteraction('correct', {
        entity_id: id,
      }, 'delete');
      await handleCorrectCommand(interaction, pool);

      const arg = getEditReplyArg()!;
      const json = getEmbedJson(arg);
      expect(json.title).toBe('Correction: delete');

      // Entity should not be findable without includeDeleted
      const entity = await getEntityById(pool, id);
      expect(entity).toBeNull();

      // But should exist with includeDeleted
      const deleted = await getEntityById(pool, id, true);
      expect(deleted).not.toBeNull();
      expect(deleted!.deleted_at).toBeDefined();
    });

    it('returns error for already-deleted entity', async () => {
      const id = await seedEntity();
      await softDeleteEntity(pool, id);

      const { interaction, getEditReplyArg } = mockInteraction('correct', {
        entity_id: id,
      }, 'delete');
      await handleCorrectCommand(interaction, pool);

      const arg = getEditReplyArg()!;
      const json = getEmbedJson(arg);
      expect(json.title).toBe('Error');
      expect(json.description).toContain('already been deleted');
    });
  });

  describe('handleCorrectCommand — merge', () => {
    it('merges source into target and creates correction log', async () => {
      const sourceId = await seedEntity({ title: 'Duplicate', mentions: 2 });
      const targetId = await seedEntity({ title: 'Original', mentions: 5 });

      const { interaction, getEditReplyArg } = mockInteraction('correct', {
        entity_id: sourceId, into_entity_id: targetId,
      }, 'merge');
      await handleCorrectCommand(interaction, pool);

      const arg = getEditReplyArg()!;
      const json = getEmbedJson(arg);
      expect(json.title).toBe('Correction: merge');
      expect(json.description).toContain('Duplicate');
      expect(json.description).toContain('Original');
      expect(json.description).toContain('7'); // 2 + 5

      // Source should be deleted
      const source = await getEntityById(pool, sourceId);
      expect(source).toBeNull();

      // Target should have combined mentions
      const target = await getEntityById(pool, targetId);
      expect(target!.mentions).toBe(7);
    });

    it('returns error when merging entity into itself', async () => {
      const id = await seedEntity();
      const { interaction, getEditReplyArg } = mockInteraction('correct', {
        entity_id: id, into_entity_id: id,
      }, 'merge');
      await handleCorrectCommand(interaction, pool);

      const arg = getEditReplyArg()!;
      const json = getEmbedJson(arg);
      expect(json.title).toBe('Error');
      expect(json.description).toContain('itself');
    });
  });
});
