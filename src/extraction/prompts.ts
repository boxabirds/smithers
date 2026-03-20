import type { MessageRow } from '../db/messages.js';
import type { EntityContextItem } from '../db/entities.js';

/**
 * Builds the extraction prompt for file-based extraction with entity context.
 * When entityContext is provided, the prompt references two attached JSON files
 * (entities + messages) and supports both new entity and update record outputs.
 * When no context, falls back to inline messages for backward compatibility.
 */
export function buildExtractionPrompt(
  messages: MessageRow[],
  entityContext?: EntityContextItem[],
): string {
  if (entityContext && entityContext.length > 0) {
    return buildContextAwarePrompt();
  }
  return buildInlinePrompt(messages);
}

function buildContextAwarePrompt(): string {
  return `You are analysing Discord messages for a server. You have access to two attached JSON files:

1. **entities.json** — ALL previously extracted entities (the server's knowledge base)
2. **messages.json** — NEW messages to analyse

Your job: extract new entities AND detect when new messages resolve, complete, or answer existing entities.

Return a JSON object with an "entities" array. Each element is EITHER a new entity OR an update to an existing one:

New entity:
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

Update to existing entity:
{
  "resolves_existing_id": 47,
  "status": "resolved",
  "body": "optional: brief note on how it was resolved",
  "confidence": 0.0-1.0,
  "evidence_message_ids": ["msg_id"]
}

Entity type definitions:
- project: A named initiative, product, feature, or workstream being discussed
- action: Something someone said they would do, or was asked to do
- question: A question that was asked — mark resolved if answered
- decision: An explicit decision or agreement reached
- concept: A technical concept, architecture pattern, or idea discussed substantively
- resource: A URL, tool, library, or reference shared

Rules:
- When a message clearly resolves, completes, or answers a known entity from entities.json, emit an update with resolves_existing_id set to that entity's id.
- Do NOT guess entity IDs. Only use IDs that appear in entities.json.
- If you are unsure whether a message refers to a known entity, extract it as a NEW entity with the closest title you can.
- A single message can both resolve an existing entity AND create new ones.
- Be selective. Not every message warrants an entity.
- Merge related messages into single entities where they discuss the same thing.
- For actions, always try to identify an assignee.
- For questions, mark as resolved if the answer appears in the messages.
- Confidence < 0.5 for anything ambiguous or speculative.`;
}

function buildInlinePrompt(messages: MessageRow[]): string {
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
