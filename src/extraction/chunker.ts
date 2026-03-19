import type { MessageRow } from '../db/messages.js';

const CHARS_PER_TOKEN = 4;

function estimateTokens(messages: MessageRow[]): number {
  return messages.reduce((sum, m) => sum + Math.ceil(m.content.length / CHARS_PER_TOKEN), 0);
}

export function chunkMessages(
  messages: MessageRow[],
  batchSize: number = 75,
  tokenBudget: number = 100000,
): MessageRow[][] {
  if (messages.length === 0) return [];

  // Group by thread_id. Messages without a thread (null) are individual groups.
  const groups: MessageRow[][] = [];
  const threadGroups = new Map<string, MessageRow[]>();

  for (const msg of messages) {
    if (msg.thread_id) {
      const group = threadGroups.get(msg.thread_id);
      if (group) {
        group.push(msg);
      } else {
        threadGroups.set(msg.thread_id, [msg]);
      }
    } else {
      groups.push([msg]);
    }
  }

  // Add thread groups after individual messages
  for (const group of threadGroups.values()) {
    groups.push(group);
  }

  // Sort groups by earliest message
  const sortedGroups = [...groups.values()].sort(
    (a, b) => a[0].created_at.getTime() - b[0].created_at.getTime(),
  );

  const chunks: MessageRow[][] = [];
  let currentChunk: MessageRow[] = [];

  for (const group of sortedGroups) {
    const wouldExceedBatch = currentChunk.length + group.length > batchSize;
    const wouldExceedTokens = estimateTokens([...currentChunk, ...group]) > tokenBudget;

    if ((wouldExceedBatch || wouldExceedTokens) && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [...group];
    } else {
      currentChunk.push(...group);
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}
