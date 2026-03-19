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
} from '../src/bot/commands/formatters.js';
import { buildCommandDefinitions } from '../src/bot/commands/register.js';
import { KNOWN_COMMAND_NAMES } from '../src/bot/commands/index.js';
import {
  EMBED_COLOURS,
  EMBED_FIELD_MAX_LENGTH,
  EMPTY_MESSAGES,
  DEFAULT_LOOKBACK_DAYS,
} from '../src/bot/commands/constants.js';

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

// ─── Command Definition Tests ─────────────────────────────────────

describe('buildCommandDefinitions', () => {
  const commands = buildCommandDefinitions();

  it('defines exactly 6 commands', () => {
    expect(commands).toHaveLength(6);
  });

  it('has all expected command names', () => {
    const names = commands.map((c) => c.name);
    expect(names).toEqual(['actions', 'questions', 'digest', 'projects', 'decisions', 'status']);
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
});

// ─── Router Tests ─────────────────────────────────────────────────

describe('KNOWN_COMMAND_NAMES', () => {
  it('includes all 6 command names', () => {
    expect(KNOWN_COMMAND_NAMES).toEqual(
      expect.arrayContaining(['actions', 'questions', 'digest', 'projects', 'decisions', 'status']),
    );
    expect(KNOWN_COMMAND_NAMES).toHaveLength(6);
  });
});
