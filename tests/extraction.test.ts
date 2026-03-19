import { describe, it, expect } from 'vitest';
import { buildExtractionPrompt } from '../src/extraction/prompts.js';
import { calculateCost } from '../src/extraction/scheduler.js';
import type { MessageRow } from '../src/db/messages.js';

function makeMsg(id: string): MessageRow {
  return {
    id,
    channel_id: '100',
    guild_id: '200',
    author_id: '300',
    author_name: 'alice',
    content: `Hello from message ${id}`,
    created_at: new Date('2024-01-15T10:00:00Z'),
    has_attachments: false,
    reply_to_id: null,
    thread_id: null,
  };
}

describe('buildExtractionPrompt', () => {
  it('includes author name, timestamp, and content for each message', () => {
    const prompt = buildExtractionPrompt([makeMsg('1'), makeMsg('2')]);
    expect(prompt).toContain('alice');
    expect(prompt).toContain('2024-01-15');
    expect(prompt).toContain('Hello from message 1');
    expect(prompt).toContain('Hello from message 2');
  });

  it('includes entity type definitions', () => {
    const prompt = buildExtractionPrompt([makeMsg('1')]);
    expect(prompt).toContain('project');
    expect(prompt).toContain('action');
    expect(prompt).toContain('question');
    expect(prompt).toContain('decision');
    expect(prompt).toContain('concept');
    expect(prompt).toContain('resource');
  });

  it('includes JSON schema', () => {
    const prompt = buildExtractionPrompt([makeMsg('1')]);
    expect(prompt).toContain('"entities"');
    expect(prompt).toContain('"type"');
    expect(prompt).toContain('"title"');
    expect(prompt).toContain('evidence_message_ids');
  });
});

describe('calculateCost', () => {
  it('calculates cost for known token counts', () => {
    // 100K input tokens at $0.10/M = $0.01
    // 20K output tokens at $0.40/M = $0.008
    const cost = calculateCost(100_000, 20_000);
    expect(cost).toBeCloseTo(0.018, 4);
  });

  it('returns 0 for zero tokens', () => {
    expect(calculateCost(0, 0)).toBe(0);
  });

  it('handles large token counts', () => {
    // 2.5M input, 500K output
    const cost = calculateCost(2_500_000, 500_000);
    expect(cost).toBeCloseTo(0.45, 2);
  });
});
