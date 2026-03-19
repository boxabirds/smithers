import type { MessageRow } from '../db/messages.js';

export function buildExtractionPrompt(messages: MessageRow[]): string {
  const formattedMessages = messages
    .map((m) => `${m.author_name} (${m.created_at.toISOString()}): ${m.content}`)
    .join('\n');

  return `You are analysing a chunk of Discord conversation. Extract structured entities.

For each entity, return JSON matching this schema:
{
  "entities": [
    {
      "type": "project" | "action" | "question" | "decision" | "concept" | "resource",
      "title": "short descriptive title",
      "body": "fuller context, 1-3 sentences",
      "status": "open" | "resolved" | "closed",
      "confidence": 0.0-1.0,
      "people": ["username1", "username2"],
      "metadata": {
        "assignee": "username or null",
        "deadline": "ISO date or null",
        "tags": ["tag1", "tag2"],
        "url": "any URL mentioned"
      },
      "evidence_message_ids": ["msg_id_1", "msg_id_2"]
    }
  ]
}

Entity type definitions:
- project: A named initiative, product, feature, or workstream being discussed
- action: Something someone said they would do, or was asked to do
- question: A question that was asked — mark resolved if answered in this chunk
- decision: An explicit decision or agreement reached
- concept: A technical concept, architecture pattern, or idea discussed substantively
- resource: A URL, tool, library, or reference shared

Rules:
- Be selective. Not every message warrants an entity.
- Merge related messages into single entities where they discuss the same thing.
- For actions, always try to identify an assignee.
- For questions, mark as resolved if the answer appears in the conversation.
- Confidence < 0.5 for anything ambiguous or speculative.

Messages:
${formattedMessages}`;
}
