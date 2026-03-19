import { describe, it, expect } from 'vitest';
import { chunkMessages } from '../src/extraction/chunker.js';
import type { MessageRow } from '../src/db/messages.js';

function makeMsg(id: string, overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id,
    channel_id: '100',
    guild_id: '200',
    author_id: '300',
    author_name: 'user',
    content: `Message ${id}`,
    created_at: new Date(`2024-01-15T10:${String(Number(id) % 60).padStart(2, '0')}:00Z`),
    has_attachments: false,
    reply_to_id: null,
    thread_id: null,
    ...overrides,
  };
}

describe('chunkMessages', () => {
  it('returns empty array for zero messages', () => {
    expect(chunkMessages([])).toEqual([]);
  });

  it('puts 50 messages in 1 chunk when batch size is 75', () => {
    const msgs = Array.from({ length: 50 }, (_, i) => makeMsg(String(i)));
    const chunks = chunkMessages(msgs, 75);
    expect(chunks.length).toBe(1);
    expect(chunks[0].length).toBe(50);
  });

  it('splits 200 messages into multiple chunks', () => {
    const msgs = Array.from({ length: 200 }, (_, i) => makeMsg(String(i)));
    const chunks = chunkMessages(msgs, 75);
    expect(chunks.length).toBe(3); // 75 + 75 + 50
    expect(chunks[0].length).toBe(75);
    expect(chunks[1].length).toBe(75);
    expect(chunks[2].length).toBe(50);
  });

  it('keeps thread groups together', () => {
    const msgs = [
      ...Array.from({ length: 70 }, (_, i) => makeMsg(String(i))),
      // Thread group of 10 messages — should stay together
      ...Array.from({ length: 10 }, (_, i) => makeMsg(String(70 + i), {
        thread_id: 'thread-1',
        created_at: new Date('2024-01-15T11:00:00Z'),
      })),
    ];
    const chunks = chunkMessages(msgs, 75);
    // The 70 main channel msgs fill first chunk, then the thread group of 10 goes to second
    expect(chunks.length).toBe(2);
    // All thread messages should be in the same chunk
    const threadChunk = chunks.find(c => c.some(m => m.thread_id === 'thread-1'));
    expect(threadChunk).toBeDefined();
    const threadMsgs = threadChunk!.filter(m => m.thread_id === 'thread-1');
    expect(threadMsgs.length).toBe(10);
  });

  it('handles single message', () => {
    const chunks = chunkMessages([makeMsg('1')], 75);
    expect(chunks.length).toBe(1);
    expect(chunks[0].length).toBe(1);
  });

  it('handles oversized group that exceeds batch limit', () => {
    // A single thread group of 100 messages — cannot be split
    const msgs = Array.from({ length: 100 }, (_, i) => makeMsg(String(i), { thread_id: 'big-thread' }));
    const chunks = chunkMessages(msgs, 75);
    // Should still be 1 chunk since it's a single group
    expect(chunks.length).toBe(1);
    expect(chunks[0].length).toBe(100);
  });
});
