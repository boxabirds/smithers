import { describe, it, expect } from 'vitest';
import {
  formatActionsEmbed,
  formatQuestionsEmbed,
  formatDigestEmbed,
  formatProjectsEmbed,
  formatDecisionsEmbed,
  formatStatusEmbed,
  formatErrorEmbed,
  formatUptime,
  formatSearchResultsEmbed,
  formatCorrectionEmbed,
  formatMergeEmbed,
} from '../src/bot/commands/formatters.js';
import { buildCommandDefinitions } from '../src/bot/commands/register.js';
import { KNOWN_COMMAND_NAMES } from '../src/bot/commands/index.js';
import {
  EMBED_COLOURS,
  EMBED_FIELD_MAX_LENGTH,
  EMPTY_MESSAGES,
  DEFAULT_LOOKBACK_DAYS,
  VALID_ENTITY_TYPES,
  MAX_SEARCH_RESULTS,
} from '../src/bot/commands/constants.js';

/** Number of total slash commands (original 6 + search + correct) */
const TOTAL_COMMAND_COUNT = 8;

/** Number of subcommands under /correct */
const CORRECT_SUBCOMMAND_COUNT = 5;

// ─── Formatter Tests ──────────────────────────────────────────────

describe('formatActionsEmbed', () => {
  it('shows empty-state message when count is 0', () => {
    const embed = formatActionsEmbed({ actions: [], count: 0 });
    const json = embed.toJSON();
    expect(json.description).toBe(EMPTY_MESSAGES.ACTIONS);
    expect(json.title).toBe('Open Action Items');
    expect(json.color).toBe(EMBED_COLOURS.ACTIONS);
  });

  it('lists action titles with assignee and date', () => {
    const embed = formatActionsEmbed({
      actions: [
        { title: 'Deploy auth', metadata: { assignee: 'alice' }, last_seen: '2025-06-01T00:00:00Z' },
        { title: 'Update docs', metadata: {}, last_seen: '2025-06-02T00:00:00Z' },
      ],
      count: 2,
    });
    const json = embed.toJSON();
    expect(json.description).toContain('Deploy auth');
    expect(json.description).toContain('(assigned: alice)');
    expect(json.description).toContain('Update docs');
    expect(json.footer?.text).toBe('2 action(s)');
  });

  it('handles action with null body and no assignee', () => {
    const embed = formatActionsEmbed({
      actions: [{ title: 'Simple task', body: null, metadata: {} }],
      count: 1,
    });
    const json = embed.toJSON();
    expect(json.description).toContain('Simple task');
    expect(json.description).not.toContain('assigned');
  });

  it('truncates very long titles', () => {
    const longTitle = 'A'.repeat(300);
    const embed = formatActionsEmbed({
      actions: [{ title: longTitle, metadata: {} }],
      count: 1,
    });
    const json = embed.toJSON();
    // Title in description should be truncated
    expect(json.description!.length).toBeLessThan(longTitle.length + 50);
    expect(json.description).toContain('...');
  });
});

describe('formatQuestionsEmbed', () => {
  it('shows empty-state message when count is 0', () => {
    const embed = formatQuestionsEmbed({ questions: [], count: 0 });
    const json = embed.toJSON();
    expect(json.description).toBe(EMPTY_MESSAGES.QUESTIONS);
    expect(json.color).toBe(EMBED_COLOURS.QUESTIONS);
  });

  it('lists question titles with date', () => {
    const embed = formatQuestionsEmbed({
      questions: [{ title: 'Which DB?', first_seen: '2025-06-01T00:00:00Z' }],
      count: 1,
    });
    const json = embed.toJSON();
    expect(json.description).toContain('Which DB?');
    expect(json.footer?.text).toBe('1 question(s)');
  });
});

describe('formatDigestEmbed', () => {
  it('shows empty-state message when total is 0', () => {
    const embed = formatDigestEmbed(
      {
        summary: { projects: 0, actions: 0, decisions: 0, questions: 0, concepts: 0, resources: 0, total: 0 },
        entities: [],
        period: { since: '2025-05-25T00:00:00Z', until: '2025-06-01T00:00:00Z' },
      },
      DEFAULT_LOOKBACK_DAYS,
    );
    const json = embed.toJSON();
    expect(json.description).toBe(EMPTY_MESSAGES.DIGEST(DEFAULT_LOOKBACK_DAYS));
    expect(json.color).toBe(EMBED_COLOURS.DIGEST);
  });

  it('shows summary counts when entities exist', () => {
    const embed = formatDigestEmbed(
      {
        summary: { projects: 2, actions: 3, decisions: 1, questions: 4, concepts: 0, resources: 0, total: 10 },
        entities: [],
        period: { since: '2025-05-25T00:00:00Z', until: '2025-06-01T00:00:00Z' },
      },
      7,
    );
    const json = embed.toJSON();
    expect(json.description).toContain('**Projects:** 2');
    expect(json.description).toContain('**Actions:** 3');
    expect(json.description).toContain('**Total:** 10');
    expect(json.title).toContain('7');
  });

  it('shows zero counts correctly', () => {
    const embed = formatDigestEmbed(
      {
        summary: { projects: 0, actions: 0, decisions: 0, questions: 0, concepts: 0, resources: 0, total: 1 },
        entities: [{ title: 'Something' }],
        period: { since: '2025-06-01T00:00:00Z', until: '2025-06-01T00:00:00Z' },
      },
      1,
    );
    const json = embed.toJSON();
    expect(json.description).toContain('**Projects:** 0');
  });
});

describe('formatProjectsEmbed', () => {
  it('shows empty-state message when count is 0', () => {
    const embed = formatProjectsEmbed({ projects: [], count: 0 });
    const json = embed.toJSON();
    expect(json.description).toBe(EMPTY_MESSAGES.PROJECTS);
    expect(json.color).toBe(EMBED_COLOURS.PROJECTS);
  });

  it('lists projects with mention count', () => {
    const embed = formatProjectsEmbed({
      projects: [{ title: 'Auth system', mentions: 5 }],
      count: 1,
    });
    const json = embed.toJSON();
    expect(json.description).toContain('Auth system');
    expect(json.description).toContain('5 mentions');
  });
});

describe('formatDecisionsEmbed', () => {
  it('shows empty-state message when count is 0', () => {
    const embed = formatDecisionsEmbed({ decisions: [], count: 0 }, DEFAULT_LOOKBACK_DAYS);
    const json = embed.toJSON();
    expect(json.description).toBe(EMPTY_MESSAGES.DECISIONS(DEFAULT_LOOKBACK_DAYS));
    expect(json.color).toBe(EMBED_COLOURS.DECISIONS);
  });

  it('lists decisions with body snippet and date', () => {
    const embed = formatDecisionsEmbed(
      {
        decisions: [{ title: 'Use PostgreSQL', body: 'Team agreed', last_seen: '2025-06-01T00:00:00Z' }],
        count: 1,
      },
      7,
    );
    const json = embed.toJSON();
    expect(json.description).toContain('Use PostgreSQL');
    expect(json.description).toContain('Team agreed');
    expect(json.footer?.text).toBe('1 decision(s)');
  });
});

describe('formatStatusEmbed', () => {
  it('shows uptime, message count, and entity count', () => {
    const embed = formatStatusEmbed({ uptimeMs: 3_661_000, messageCount: 42, entityCount: 10 });
    const json = embed.toJSON();
    expect(json.title).toBe('Bot Status');
    expect(json.color).toBe(EMBED_COLOURS.STATUS);
    expect(json.fields).toHaveLength(3);
    expect(json.fields![0].name).toBe('Uptime');
    expect(json.fields![0].value).toBe('1h 1m');
    expect(json.fields![1].value).toBe('42');
    expect(json.fields![2].value).toBe('10');
  });

  it('shows zero counts correctly', () => {
    const embed = formatStatusEmbed({ uptimeMs: 0, messageCount: 0, entityCount: 0 });
    const json = embed.toJSON();
    expect(json.fields![0].value).toBe('0s');
    expect(json.fields![1].value).toBe('0');
  });

  it('shows days in uptime for long-running bot', () => {
    const twoDaysMs = 2 * 24 * 60 * 60 * 1000 + 3 * 60 * 60 * 1000;
    const embed = formatStatusEmbed({ uptimeMs: twoDaysMs, messageCount: 100, entityCount: 50 });
    const json = embed.toJSON();
    expect(json.fields![0].value).toBe('2d 3h');
  });
});

describe('formatErrorEmbed', () => {
  it('shows error message with red colour', () => {
    const embed = formatErrorEmbed('Something went wrong');
    const json = embed.toJSON();
    expect(json.title).toBe('Error');
    expect(json.description).toBe('Something went wrong');
    expect(json.color).toBe(EMBED_COLOURS.ERROR);
  });
});

describe('formatUptime', () => {
  it('returns seconds for sub-minute', () => {
    expect(formatUptime(45_000)).toBe('45s');
  });

  it('returns minutes for sub-hour', () => {
    expect(formatUptime(5 * 60 * 1000)).toBe('5m');
  });

  it('returns hours and minutes', () => {
    expect(formatUptime(2 * 60 * 60 * 1000 + 30 * 60 * 1000)).toBe('2h 30m');
  });

  it('returns days, hours, minutes', () => {
    expect(formatUptime(1 * 86_400_000 + 2 * 3_600_000 + 15 * 60_000)).toBe('1d 2h 15m');
  });

  it('returns 0s for zero', () => {
    expect(formatUptime(0)).toBe('0s');
  });
});

// ─── Search & Correction Formatter Tests ─────────────────────────

describe('formatSearchResultsEmbed', () => {
  it('shows empty-state message when no results', () => {
    const embed = formatSearchResultsEmbed([], 'auth');
    const json = embed.toJSON();
    expect(json.description).toBe(EMPTY_MESSAGES.SEARCH);
    expect(json.color).toBe(EMBED_COLOURS.SEARCH);
    expect(json.title).toContain('auth');
  });

  it('lists results with ID, type, title, and status', () => {
    const embed = formatSearchResultsEmbed(
      [
        { id: 1, type: 'action', title: 'Deploy auth', status: 'open' },
        { id: 2, type: 'decision', title: 'Use PostgreSQL', status: 'resolved' },
      ],
      'auth',
    );
    const json = embed.toJSON();
    expect(json.description).toContain('#1');
    expect(json.description).toContain('[action]');
    expect(json.description).toContain('Deploy auth');
    expect(json.description).toContain('(open)');
    expect(json.description).toContain('#2');
    expect(json.description).toContain('[decision]');
    expect(json.description).toContain('(resolved)');
    expect(json.footer?.text).toBe('2 result(s)');
  });

  it('truncates long titles in results', () => {
    const longTitle = 'B'.repeat(300);
    const embed = formatSearchResultsEmbed(
      [{ id: 1, type: 'project', title: longTitle, status: 'open' }],
      'test',
    );
    const json = embed.toJSON();
    expect(json.description).toContain('...');
  });
});

describe('formatCorrectionEmbed', () => {
  it('shows retype correction with before and after', () => {
    const embed = formatCorrectionEmbed('retype', 42, 'Deploy auth', 'decision', 'action', '12345');
    const json = embed.toJSON();
    expect(json.title).toBe('Correction: retype');
    expect(json.color).toBe(EMBED_COLOURS.CORRECT);
    expect(json.description).toContain('#42');
    expect(json.description).toContain('Deploy auth');
    expect(json.description).toContain('decision');
    expect(json.description).toContain('action');
    expect(json.description).toContain('<@12345>');
  });

  it('shows retitle correction with old and new title', () => {
    const embed = formatCorrectionEmbed('retitle', 10, 'New Title', 'Old Title', 'New Title', '99');
    const json = embed.toJSON();
    expect(json.title).toBe('Correction: retitle');
    expect(json.description).toContain('Old Title');
    expect(json.description).toContain('New Title');
  });

  it('shows resolve correction', () => {
    const embed = formatCorrectionEmbed('resolve', 5, 'Some question', 'open', 'resolved', '88');
    const json = embed.toJSON();
    expect(json.title).toBe('Correction: resolve');
    expect(json.description).toContain('open');
    expect(json.description).toContain('resolved');
  });

  it('shows delete correction', () => {
    const embed = formatCorrectionEmbed('delete', 7, 'Bad entity', 'active', 'deleted', '77');
    const json = embed.toJSON();
    expect(json.title).toBe('Correction: delete');
    expect(json.description).toContain('active');
    expect(json.description).toContain('deleted');
  });
});

describe('formatMergeEmbed', () => {
  it('shows source merged into target with mention count', () => {
    const embed = formatMergeEmbed(
      { id: 1, title: 'Duplicate entity' },
      { id: 2, title: 'Original entity', mentions: 8 },
      '12345',
    );
    const json = embed.toJSON();
    expect(json.title).toBe('Correction: merge');
    expect(json.color).toBe(EMBED_COLOURS.CORRECT);
    expect(json.description).toContain('#1');
    expect(json.description).toContain('Duplicate entity');
    expect(json.description).toContain('(deleted)');
    expect(json.description).toContain('#2');
    expect(json.description).toContain('Original entity');
    expect(json.description).toContain('8');
    expect(json.description).toContain('<@12345>');
  });
});

// ─── Constants Tests ─────────────────────────────────────────────

describe('VALID_ENTITY_TYPES', () => {
  it('contains all 6 entity types', () => {
    expect(VALID_ENTITY_TYPES).toHaveLength(6);
    expect(VALID_ENTITY_TYPES).toContain('project');
    expect(VALID_ENTITY_TYPES).toContain('action');
    expect(VALID_ENTITY_TYPES).toContain('question');
    expect(VALID_ENTITY_TYPES).toContain('decision');
    expect(VALID_ENTITY_TYPES).toContain('concept');
    expect(VALID_ENTITY_TYPES).toContain('resource');
  });
});

describe('MAX_SEARCH_RESULTS', () => {
  it('is a positive number', () => {
    expect(MAX_SEARCH_RESULTS).toBeGreaterThan(0);
  });
});

// ─── Command Definition Tests ─────────────────────────────────────

describe('buildCommandDefinitions', () => {
  const commands = buildCommandDefinitions();

  it(`defines exactly ${TOTAL_COMMAND_COUNT} commands`, () => {
    expect(commands).toHaveLength(TOTAL_COMMAND_COUNT);
  });

  it('has all expected command names', () => {
    const names = commands.map((c) => c.name);
    expect(names).toEqual(['actions', 'questions', 'digest', 'projects', 'decisions', 'status', 'search', 'correct']);
  });

  it('actions command has optional string assignee parameter', () => {
    const actions = commands.find((c) => c.name === 'actions')!;
    const json = actions.toJSON();
    const assigneeOpt = json.options?.find((o: Record<string, unknown>) => o.name === 'assignee');
    expect(assigneeOpt).toBeDefined();
    expect(assigneeOpt!.required).toBeFalsy();
    // ApplicationCommandOptionType.String = 3
    expect(assigneeOpt!.type).toBe(3);
  });

  it('digest command has optional integer days parameter with min value', () => {
    const digest = commands.find((c) => c.name === 'digest')!;
    const json = digest.toJSON();
    const daysOpt = json.options?.find((o: Record<string, unknown>) => o.name === 'days');
    expect(daysOpt).toBeDefined();
    expect(daysOpt!.required).toBeFalsy();
    // ApplicationCommandOptionType.Integer = 4
    expect(daysOpt!.type).toBe(4);
    expect(daysOpt!.min_value).toBe(1);
  });

  it('decisions command has optional integer days parameter', () => {
    const decisions = commands.find((c) => c.name === 'decisions')!;
    const json = decisions.toJSON();
    const daysOpt = json.options?.find((o: Record<string, unknown>) => o.name === 'days');
    expect(daysOpt).toBeDefined();
    expect(daysOpt!.type).toBe(4);
  });

  it('questions, projects, status have no options', () => {
    for (const name of ['questions', 'projects', 'status']) {
      const cmd = commands.find((c) => c.name === name)!;
      const json = cmd.toJSON();
      expect(json.options ?? []).toHaveLength(0);
    }
  });

  it('search command has required query string parameter', () => {
    const search = commands.find((c) => c.name === 'search')!;
    const json = search.toJSON();
    const queryOpt = json.options?.find((o: Record<string, unknown>) => o.name === 'query');
    expect(queryOpt).toBeDefined();
    expect(queryOpt!.required).toBe(true);
    // ApplicationCommandOptionType.String = 3
    expect(queryOpt!.type).toBe(3);
  });

  it(`correct command has exactly ${CORRECT_SUBCOMMAND_COUNT} subcommands`, () => {
    const correct = commands.find((c) => c.name === 'correct')!;
    const json = correct.toJSON();
    // ApplicationCommandOptionType.Subcommand = 1
    const subcommands = json.options?.filter((o: Record<string, unknown>) => o.type === 1) ?? [];
    expect(subcommands).toHaveLength(CORRECT_SUBCOMMAND_COUNT);
    const names = subcommands.map((s: Record<string, unknown>) => s.name);
    expect(names).toEqual(expect.arrayContaining(['retype', 'retitle', 'resolve', 'delete', 'merge']));
  });

  it('correct retype subcommand has entity_id (integer) and new_type (string with choices)', () => {
    const correct = commands.find((c) => c.name === 'correct')!;
    const json = correct.toJSON();
    const retype = json.options?.find((o: Record<string, unknown>) => o.name === 'retype') as Record<string, unknown>;
    expect(retype).toBeDefined();
    const retypeOptions = retype.options as Record<string, unknown>[];
    const entityIdOpt = retypeOptions.find((o) => o.name === 'entity_id');
    expect(entityIdOpt).toBeDefined();
    expect(entityIdOpt!.required).toBe(true);
    // ApplicationCommandOptionType.Integer = 4
    expect(entityIdOpt!.type).toBe(4);
    const newTypeOpt = retypeOptions.find((o) => o.name === 'new_type');
    expect(newTypeOpt).toBeDefined();
    expect(newTypeOpt!.required).toBe(true);
    expect(newTypeOpt!.type).toBe(3); // String
    expect((newTypeOpt!.choices as unknown[]).length).toBe(VALID_ENTITY_TYPES.length);
  });

  it('correct merge subcommand has entity_id and into_entity_id (both integer)', () => {
    const correct = commands.find((c) => c.name === 'correct')!;
    const json = correct.toJSON();
    const merge = json.options?.find((o: Record<string, unknown>) => o.name === 'merge') as Record<string, unknown>;
    expect(merge).toBeDefined();
    const mergeOptions = merge.options as Record<string, unknown>[];
    const entityIdOpt = mergeOptions.find((o) => o.name === 'entity_id');
    expect(entityIdOpt).toBeDefined();
    expect(entityIdOpt!.type).toBe(4);
    expect(entityIdOpt!.required).toBe(true);
    const intoOpt = mergeOptions.find((o) => o.name === 'into_entity_id');
    expect(intoOpt).toBeDefined();
    expect(intoOpt!.type).toBe(4);
    expect(intoOpt!.required).toBe(true);
  });
});

// ─── Router Tests ─────────────────────────────────────────────────

describe('KNOWN_COMMAND_NAMES', () => {
  it(`includes all ${TOTAL_COMMAND_COUNT} command names`, () => {
    expect(KNOWN_COMMAND_NAMES).toEqual(
      expect.arrayContaining(['actions', 'questions', 'digest', 'projects', 'decisions', 'status', 'search', 'correct']),
    );
    expect(KNOWN_COMMAND_NAMES).toHaveLength(TOTAL_COMMAND_COUNT);
  });
});
