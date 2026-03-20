import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import { runMigrations } from '../src/db/migrate.js';
import { insertEntity } from '../src/db/entities.js';
import { insertMessage } from '../src/db/messages.js';
import { ensureGuildConfig } from '../src/db/guild-config.js';
import {
  handleActionsCommand,
  handleQuestionsCommand,
  handleDigestCommand,
  handleProjectsCommand,
  handleDecisionsCommand,
  handleStatusCommand,
} from '../src/bot/commands/handlers.js';
import { handleSlashCommand } from '../src/bot/commands/index.js';
import { buildCommandDefinitions } from '../src/bot/commands/register.js';
import { EMPTY_MESSAGES } from '../src/bot/commands/constants.js';
import type { ChatInputCommandInteraction } from 'discord.js';

const TEST_DB_URL = process.env.DATABASE_URL || 'postgres://secretary:secretpassword@localhost:5432/secretary';

/**
 * Creates a mock Discord ChatInputCommandInteraction.
 * Captures editReply and reply calls for assertion.
 */
function mockInteraction(commandName: string, options: Record<string, unknown> = {}): {
  interaction: ChatInputCommandInteraction;
  getEditReplyArg: () => Record<string, unknown> | null;
  getReplyArg: () => Record<string, unknown> | null;
} {
  let editReplyArg: Record<string, unknown> | null = null;
  let replyArg: Record<string, unknown> | null = null;

  const interaction = {
    commandName,
    guildId: '200',
    deferred: false,
    options: {
      getString: (name: string) => options[name] as string | null ?? null,
      getInteger: (name: string) => options[name] as number | null ?? null,
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

describe('Command Handlers (Integration)', () => {
  let pool: pg.Pool;
  const now = new Date();
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const botStartTime = new Date(Date.now() - 3_600_000); // 1 hour ago

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
  });

  async function seedStandardData() {
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
      guild_id: '200', type: 'project', title: 'Authentication system',
      body: 'Building OAuth-based auth', status: 'open', confidence: 1.0,
      first_seen: weekAgo, last_seen: now, mentions: 5, metadata: {},
    });
    await insertEntity(pool, {
      guild_id: '200', type: 'decision', title: 'Use PostgreSQL for main database',
      body: 'Team agreed on PostgreSQL', status: 'open', confidence: 1.0,
      first_seen: now, last_seen: now, mentions: 2, metadata: {},
    });
  }

  describe('handleActionsCommand', () => {
    it('returns embed with action titles', async () => {
      await seedStandardData();
      const { interaction, getEditReplyArg } = mockInteraction('actions');
      await handleActionsCommand(interaction, pool);

      const arg = getEditReplyArg()!;
      expect(arg.embeds).toHaveLength(1);
      const embedJson = (arg.embeds as { toJSON: () => Record<string, unknown> }[])[0].toJSON();
      expect(embedJson.description).toContain('Deploy auth service');
      expect(embedJson.description).toContain('Update docs');
    });

    it('filters by assignee', async () => {
      await seedStandardData();
      const { interaction, getEditReplyArg } = mockInteraction('actions', { assignee: 'alice' });
      await handleActionsCommand(interaction, pool);

      const arg = getEditReplyArg()!;
      const embedJson = (arg.embeds as { toJSON: () => Record<string, unknown> }[])[0].toJSON();
      expect(embedJson.description).toContain('Deploy auth service');
      expect(embedJson.description).not.toContain('Update docs');
    });

    it('shows empty-state when no actions exist', async () => {
      const { interaction, getEditReplyArg } = mockInteraction('actions');
      await handleActionsCommand(interaction, pool);

      const arg = getEditReplyArg()!;
      const embedJson = (arg.embeds as { toJSON: () => Record<string, unknown> }[])[0].toJSON();
      expect(embedJson.description).toBe(EMPTY_MESSAGES.ACTIONS);
    });
  });

  describe('handleQuestionsCommand', () => {
    it('returns embed with open questions', async () => {
      await seedStandardData();
      const { interaction, getEditReplyArg } = mockInteraction('questions');
      await handleQuestionsCommand(interaction, pool);

      const arg = getEditReplyArg()!;
      const embedJson = (arg.embeds as { toJSON: () => Record<string, unknown> }[])[0].toJSON();
      expect(embedJson.description).toContain('Which database to use?');
    });

    it('shows empty-state when no questions exist', async () => {
      const { interaction, getEditReplyArg } = mockInteraction('questions');
      await handleQuestionsCommand(interaction, pool);

      const arg = getEditReplyArg()!;
      const embedJson = (arg.embeds as { toJSON: () => Record<string, unknown> }[])[0].toJSON();
      expect(embedJson.description).toBe(EMPTY_MESSAGES.QUESTIONS);
    });
  });

  describe('handleDigestCommand', () => {
    it('returns digest summary with entity counts', async () => {
      await seedStandardData();
      const { interaction, getEditReplyArg } = mockInteraction('digest');
      await handleDigestCommand(interaction, pool);

      const arg = getEditReplyArg()!;
      const embedJson = (arg.embeds as { toJSON: () => Record<string, unknown> }[])[0].toJSON();
      expect(embedJson.title).toContain('7');
      expect(embedJson.description).toContain('**Actions:**');
      expect(embedJson.description).toContain('**Total:**');
    });

    it('respects custom days parameter', async () => {
      // Insert entity from 20 days ago
      await insertEntity(pool, {
        guild_id: '200', type: 'action', title: 'Old action',
        body: null, status: 'open', confidence: 0.9,
        first_seen: monthAgo, last_seen: monthAgo, mentions: 1, metadata: {},
      });

      // With 7 days window, should not see the old entity
      const { interaction: i7, getEditReplyArg: get7 } = mockInteraction('digest', { days: 7 });
      await handleDigestCommand(i7, pool);
      const embed7 = (get7()!.embeds as { toJSON: () => Record<string, unknown> }[])[0].toJSON();
      expect(embed7.description).toContain('No activity');

      // With 60 days window, should see it
      const { interaction: i60, getEditReplyArg: get60 } = mockInteraction('digest', { days: 60 });
      await handleDigestCommand(i60, pool);
      const embed60 = (get60()!.embeds as { toJSON: () => Record<string, unknown> }[])[0].toJSON();
      expect(embed60.description).toContain('**Total:**');
    });

    it('shows empty-state for no activity', async () => {
      const { interaction, getEditReplyArg } = mockInteraction('digest');
      await handleDigestCommand(interaction, pool);

      const arg = getEditReplyArg()!;
      const embedJson = (arg.embeds as { toJSON: () => Record<string, unknown> }[])[0].toJSON();
      expect(embedJson.description).toContain('No activity');
    });
  });

  describe('handleProjectsCommand', () => {
    it('returns embed with active projects', async () => {
      await seedStandardData();
      const { interaction, getEditReplyArg } = mockInteraction('projects');
      await handleProjectsCommand(interaction, pool);

      const arg = getEditReplyArg()!;
      const embedJson = (arg.embeds as { toJSON: () => Record<string, unknown> }[])[0].toJSON();
      expect(embedJson.description).toContain('Authentication system');
    });

    it('shows empty-state when no projects exist', async () => {
      const { interaction, getEditReplyArg } = mockInteraction('projects');
      await handleProjectsCommand(interaction, pool);

      const arg = getEditReplyArg()!;
      const embedJson = (arg.embeds as { toJSON: () => Record<string, unknown> }[])[0].toJSON();
      expect(embedJson.description).toBe(EMPTY_MESSAGES.PROJECTS);
    });
  });

  describe('handleDecisionsCommand', () => {
    it('returns embed with recent decisions', async () => {
      await seedStandardData();
      const { interaction, getEditReplyArg } = mockInteraction('decisions');
      await handleDecisionsCommand(interaction, pool);

      const arg = getEditReplyArg()!;
      const embedJson = (arg.embeds as { toJSON: () => Record<string, unknown> }[])[0].toJSON();
      expect(embedJson.description).toContain('Use PostgreSQL');
    });

    it('shows empty-state when no decisions in window', async () => {
      const { interaction, getEditReplyArg } = mockInteraction('decisions');
      await handleDecisionsCommand(interaction, pool);

      const arg = getEditReplyArg()!;
      const embedJson = (arg.embeds as { toJSON: () => Record<string, unknown> }[])[0].toJSON();
      expect(embedJson.description).toContain('No recent decisions');
    });
  });

  describe('handleStatusCommand', () => {
    it('returns uptime, message count, and entity count', async () => {
      await seedStandardData();
      // Also insert some messages
      await insertMessage(pool, {
        id: '9001', channel_id: '100', guild_id: '200', author_id: '300', author_name: 'alice',
        content: 'Hello', created_at: new Date(), has_attachments: false, reply_to_id: null, thread_id: null,
      });

      const { interaction, getEditReplyArg } = mockInteraction('status');
      await handleStatusCommand(interaction, pool, botStartTime);

      const arg = getEditReplyArg()!;
      const embedJson = (arg.embeds as { toJSON: () => Record<string, unknown> }[])[0].toJSON();
      expect(embedJson.title).toBe('Bot Status');
      expect(embedJson.fields).toHaveLength(3);
      // Uptime should be ~1h
      expect(embedJson.fields![0].value).toContain('h');
      // Message count should be 1
      expect(embedJson.fields![1].value).toBe('1');
      // Entity count should be 5
      expect(parseInt(embedJson.fields![2].value as string, 10)).toBeGreaterThanOrEqual(5);
    });

    it('shows zero counts when no data', async () => {
      const { interaction, getEditReplyArg } = mockInteraction('status');
      await handleStatusCommand(interaction, pool, new Date());

      const arg = getEditReplyArg()!;
      const embedJson = (arg.embeds as { toJSON: () => Record<string, unknown> }[])[0].toJSON();
      expect(embedJson.fields![1].value).toBe('0');
      expect(embedJson.fields![2].value).toBe('0');
    });
  });

  describe('buildCommandDefinitions (registration)', () => {
    it('returns 8 command builders with correct names', () => {
      const commands = buildCommandDefinitions();
      expect(commands).toHaveLength(8);
      const names = commands.map((c: { name: string }) => c.name);
      expect(names).toEqual(['actions', 'questions', 'digest', 'projects', 'decisions', 'status', 'search', 'correct']);
    });

    it('each command has a description', () => {
      const commands = buildCommandDefinitions();
      for (const cmd of commands) {
        const json = cmd.toJSON();
        expect(json.description).toBeTruthy();
      }
    });
  });

  describe('handleSlashCommand (router)', () => {
    it('routes known commands and defers reply', async () => {
      await seedStandardData();
      const { interaction, getEditReplyArg } = mockInteraction('actions');
      await handleSlashCommand(interaction, pool, botStartTime);

      expect(interaction.deferReply).toHaveBeenCalled();
      const arg = getEditReplyArg()!;
      expect(arg.embeds).toHaveLength(1);
    });

    it('replies with error embed for unknown command', async () => {
      const { interaction, getReplyArg } = mockInteraction('nonexistent');
      await handleSlashCommand(interaction, pool, botStartTime);

      const arg = getReplyArg()!;
      const embedJson = (arg.embeds as { toJSON: () => Record<string, unknown> }[])[0].toJSON();
      expect(embedJson.description).toContain('Unknown command');
    });

    it('catches handler errors and returns error embed', async () => {
      // Create a closed pool to force errors
      const closedPool = new pg.Pool({ connectionString: TEST_DB_URL });
      await closedPool.end();

      const { interaction, getEditReplyArg } = mockInteraction('actions');
      await handleSlashCommand(interaction, closedPool, botStartTime);

      const arg = getEditReplyArg()!;
      const embedJson = (arg.embeds as { toJSON: () => Record<string, unknown> }[])[0].toJSON();
      expect(embedJson.description).toContain('Something went wrong');
    });
  });
});
