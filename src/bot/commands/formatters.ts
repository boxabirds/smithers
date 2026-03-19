import { EmbedBuilder } from 'discord.js';
import {
  EMBED_COLOURS,
  EMBED_DESCRIPTION_MAX_LENGTH,
  EMBED_FIELD_MAX_LENGTH,
  EMPTY_MESSAGES,
} from './constants.js';

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

interface EntityResult {
  title: string;
  body?: string | null;
  status?: string;
  confidence?: number;
  first_seen?: Date | string;
  last_seen?: Date | string;
  mentions?: number;
  metadata?: Record<string, unknown>;
}

export function formatActionsEmbed(result: { actions: EntityResult[]; count: number }): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle('Open Action Items')
    .setColor(EMBED_COLOURS.ACTIONS);

  if (result.count === 0) {
    return embed.setDescription(EMPTY_MESSAGES.ACTIONS);
  }

  const lines = result.actions.map((a) => {
    const assignee = a.metadata?.assignee ? ` (assigned: ${a.metadata.assignee})` : '';
    const date = a.last_seen ? ` — ${formatDate(a.last_seen)}` : '';
    return `• ${truncate(a.title, EMBED_FIELD_MAX_LENGTH)}${assignee}${date}`;
  });

  const description = truncate(lines.join('\n'), EMBED_DESCRIPTION_MAX_LENGTH);
  return embed.setDescription(description).setFooter({ text: `${result.count} action(s)` });
}

export function formatQuestionsEmbed(result: { questions: EntityResult[]; count: number }): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle('Unanswered Questions')
    .setColor(EMBED_COLOURS.QUESTIONS);

  if (result.count === 0) {
    return embed.setDescription(EMPTY_MESSAGES.QUESTIONS);
  }

  const lines = result.questions.map((q) => {
    const date = q.first_seen ? ` — ${formatDate(q.first_seen)}` : '';
    return `• ${truncate(q.title, EMBED_FIELD_MAX_LENGTH)}${date}`;
  });

  const description = truncate(lines.join('\n'), EMBED_DESCRIPTION_MAX_LENGTH);
  return embed.setDescription(description).setFooter({ text: `${result.count} question(s)` });
}

export function formatDigestEmbed(
  result: { summary: Record<string, number>; entities: EntityResult[]; period: { since: string; until: string } },
  days: number,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`Activity Digest — Last ${days} Day(s)`)
    .setColor(EMBED_COLOURS.DIGEST);

  if (result.summary.total === 0) {
    return embed.setDescription(EMPTY_MESSAGES.DIGEST(days));
  }

  const summaryLines = [
    `**Projects:** ${result.summary.projects ?? 0}`,
    `**Actions:** ${result.summary.actions ?? 0}`,
    `**Decisions:** ${result.summary.decisions ?? 0}`,
    `**Questions:** ${result.summary.questions ?? 0}`,
    `**Concepts:** ${result.summary.concepts ?? 0}`,
    `**Resources:** ${result.summary.resources ?? 0}`,
    `**Total:** ${result.summary.total}`,
  ];

  const description = truncate(summaryLines.join('\n'), EMBED_DESCRIPTION_MAX_LENGTH);
  return embed
    .setDescription(description)
    .setFooter({ text: `${result.period.since.split('T')[0]} to ${result.period.until.split('T')[0]}` });
}

export function formatProjectsEmbed(result: { projects: EntityResult[]; count: number }): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle('Active Projects')
    .setColor(EMBED_COLOURS.PROJECTS);

  if (result.count === 0) {
    return embed.setDescription(EMPTY_MESSAGES.PROJECTS);
  }

  const lines = result.projects.map((p) => {
    const mentions = p.mentions ? ` (${p.mentions} mentions)` : '';
    return `• ${truncate(p.title, EMBED_FIELD_MAX_LENGTH)}${mentions}`;
  });

  const description = truncate(lines.join('\n'), EMBED_DESCRIPTION_MAX_LENGTH);
  return embed.setDescription(description).setFooter({ text: `${result.count} project(s)` });
}

export function formatDecisionsEmbed(result: { decisions: EntityResult[]; count: number }, days: number): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`Recent Decisions — Last ${days} Day(s)`)
    .setColor(EMBED_COLOURS.DECISIONS);

  if (result.count === 0) {
    return embed.setDescription(EMPTY_MESSAGES.DECISIONS(days));
  }

  const lines = result.decisions.map((d) => {
    const body = d.body ? `: ${truncate(d.body, EMBED_FIELD_MAX_LENGTH / 2)}` : '';
    const date = d.last_seen ? ` — ${formatDate(d.last_seen)}` : '';
    return `• ${truncate(d.title, EMBED_FIELD_MAX_LENGTH)}${body}${date}`;
  });

  const description = truncate(lines.join('\n'), EMBED_DESCRIPTION_MAX_LENGTH);
  return embed.setDescription(description).setFooter({ text: `${result.count} decision(s)` });
}

export interface StatusData {
  uptimeMs: number;
  messageCount: number;
  entityCount: number;
}

export function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours % 24 > 0) parts.push(`${hours % 24}h`);
  if (minutes % 60 > 0) parts.push(`${minutes % 60}m`);
  if (parts.length === 0) parts.push(`${seconds}s`);

  return parts.join(' ');
}

export function formatStatusEmbed(data: StatusData): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('Bot Status')
    .setColor(EMBED_COLOURS.STATUS)
    .addFields(
      { name: 'Uptime', value: formatUptime(data.uptimeMs), inline: true },
      { name: 'Messages Captured', value: String(data.messageCount), inline: true },
      { name: 'Entities Extracted', value: String(data.entityCount), inline: true },
    );
}

export function formatErrorEmbed(message: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('Error')
    .setColor(EMBED_COLOURS.ERROR)
    .setDescription(message);
}

// ─── Search & Correction Formatters ──────────────────────────────

export interface SearchResultEntity {
  id: number;
  type: string;
  title: string;
  status: string;
}

export function formatSearchResultsEmbed(
  results: SearchResultEntity[],
  query: string,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`Search Results: "${truncate(query, EMBED_FIELD_MAX_LENGTH)}"`)
    .setColor(EMBED_COLOURS.SEARCH);

  if (results.length === 0) {
    return embed.setDescription(EMPTY_MESSAGES.SEARCH);
  }

  const lines = results.map((r) =>
    `• **#${r.id}** [${r.type}] ${truncate(r.title, EMBED_FIELD_MAX_LENGTH)} _(${r.status})_`,
  );

  const description = truncate(lines.join('\n'), EMBED_DESCRIPTION_MAX_LENGTH);
  return embed
    .setDescription(description)
    .setFooter({ text: `${results.length} result(s)` });
}

export function formatCorrectionEmbed(
  operation: string,
  entityId: number,
  entityTitle: string,
  before: string,
  after: string,
  userId: string,
): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`Correction: ${operation}`)
    .setColor(EMBED_COLOURS.CORRECT)
    .setDescription(
      `**Entity:** #${entityId} — ${truncate(entityTitle, EMBED_FIELD_MAX_LENGTH)}\n` +
      `**Before:** ${before}\n` +
      `**After:** ${after}\n` +
      `**Corrected by:** <@${userId}>`,
    );
}

export function formatMergeEmbed(
  source: { id: number; title: string },
  target: { id: number; title: string; mentions: number },
  userId: string,
): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('Correction: merge')
    .setColor(EMBED_COLOURS.CORRECT)
    .setDescription(
      `**Source:** #${source.id} — ${truncate(source.title, EMBED_FIELD_MAX_LENGTH)} _(deleted)_\n` +
      `**Target:** #${target.id} — ${truncate(target.title, EMBED_FIELD_MAX_LENGTH)}\n` +
      `**Combined mentions:** ${target.mentions}\n` +
      `**Merged by:** <@${userId}>`,
    );
}
