import { GoogleGenerativeAI, type Part } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Config } from '../config.js';
import type { MessageRow } from '../db/messages.js';
import type { EntityContextItem } from '../db/entities.js';
import { buildExtractionPrompt } from './prompts.js';

const MAX_RETRIES = 2;
const MIN_CONFIDENCE = 0.3;

export interface ExtractedEntity {
  type: 'project' | 'action' | 'question' | 'decision' | 'concept' | 'resource';
  title: string;
  body: string | null;
  status: 'open' | 'resolved' | 'closed';
  confidence: number;
  people: string[];
  metadata: {
    assignee?: string;
    deadline?: string;
    tags?: string[];
    url?: string;
  };
  evidenceMessageIds: string[];
  resolvesExistingId?: number;
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  tokensIn: number;
  tokensOut: number;
}

const VALID_TYPES = new Set(['project', 'action', 'question', 'decision', 'concept', 'resource']);
const VALID_STATUSES = new Set(['open', 'resolved', 'closed']);

function validateEntity(raw: Record<string, unknown>): ExtractedEntity | null {
  // Update record path: resolves an existing entity by ID
  if (typeof raw.resolves_existing_id === 'number') {
    if (!VALID_STATUSES.has(raw.status as string)) return null;

    return {
      type: 'action', // placeholder — merger uses the ID, not the type
      title: '',       // placeholder — merger uses the ID, not the title
      body: typeof raw.body === 'string' ? raw.body : null,
      status: raw.status as ExtractedEntity['status'],
      confidence: typeof raw.confidence === 'number' ? raw.confidence : 1.0,
      people: [],
      metadata: {},
      evidenceMessageIds: Array.isArray(raw.evidence_message_ids)
        ? raw.evidence_message_ids.filter((id: unknown) => typeof id === 'string')
        : [],
      resolvesExistingId: raw.resolves_existing_id,
    };
  }

  // New entity path
  if (!raw.type || !VALID_TYPES.has(raw.type as string)) return null;
  if (!raw.title || typeof raw.title !== 'string') return null;

  return {
    type: raw.type as ExtractedEntity['type'],
    title: raw.title as string,
    body: typeof raw.body === 'string' ? raw.body : null,
    status: VALID_STATUSES.has(raw.status as string) ? (raw.status as ExtractedEntity['status']) : 'open',
    confidence: typeof raw.confidence === 'number' ? raw.confidence : 1.0,
    people: Array.isArray(raw.people) ? raw.people.filter((p: unknown) => typeof p === 'string') : [],
    metadata: {
      assignee: typeof (raw.metadata as Record<string, unknown>)?.assignee === 'string'
        ? (raw.metadata as Record<string, unknown>).assignee as string : undefined,
      deadline: typeof (raw.metadata as Record<string, unknown>)?.deadline === 'string'
        ? (raw.metadata as Record<string, unknown>).deadline as string : undefined,
      tags: Array.isArray((raw.metadata as Record<string, unknown>)?.tags)
        ? ((raw.metadata as Record<string, unknown>).tags as unknown[]).filter((t): t is string => typeof t === 'string') : undefined,
      url: typeof (raw.metadata as Record<string, unknown>)?.url === 'string'
        ? (raw.metadata as Record<string, unknown>).url as string : undefined,
    },
    evidenceMessageIds: Array.isArray(raw.evidence_message_ids)
      ? raw.evidence_message_ids.filter((id: unknown) => typeof id === 'string')
      : [],
  };
}

async function uploadJsonFile(
  fileManager: GoogleAIFileManager,
  data: unknown,
  displayName: string,
): Promise<{ mimeType: string; fileUri: string }> {
  const tmpPath = join(tmpdir(), `smithers-${displayName}-${Date.now()}.json`);
  try {
    writeFileSync(tmpPath, JSON.stringify(data));
    const uploadResult = await fileManager.uploadFile(tmpPath, {
      mimeType: 'application/json',
      displayName,
    });
    return {
      mimeType: uploadResult.file.mimeType,
      fileUri: uploadResult.file.uri,
    };
  } finally {
    try { unlinkSync(tmpPath); } catch { /* cleanup best-effort */ }
  }
}

function formatMessagesForUpload(messages: MessageRow[]): Record<string, unknown>[] {
  return messages.map((m) => ({
    id: m.id,
    author_name: m.author_name,
    content: m.content,
    created_at: m.created_at.toISOString(),
    channel_id: m.channel_id,
    reply_to_id: m.reply_to_id,
    thread_id: m.thread_id,
  }));
}

export async function extractEntities(
  messages: MessageRow[],
  config: Config,
  entityContext?: EntityContextItem[],
): Promise<ExtractionResult> {
  const genAI = new GoogleGenerativeAI(config.gemini.apiKey);
  const model = genAI.getGenerativeModel({
    model: config.gemini.modelId,
    generationConfig: {
      responseMimeType: 'application/json',
    },
  });

  const prompt = buildExtractionPrompt(messages, entityContext);
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      let parts: Part[];

      if (entityContext && entityContext.length > 0) {
        // File-based extraction: upload entities + messages as JSON files
        const fileManager = new GoogleAIFileManager(config.gemini.apiKey);
        const [entitiesFile, messagesFile] = await Promise.all([
          uploadJsonFile(fileManager, entityContext, 'entities'),
          uploadJsonFile(fileManager, formatMessagesForUpload(messages), 'messages'),
        ]);

        parts = [
          { fileData: entitiesFile },
          { fileData: messagesFile },
          { text: prompt },
        ];
      } else {
        // Inline extraction: prompt includes messages directly
        parts = [{ text: prompt }];
      }

      const result = await model.generateContent(parts);
      const response = result.response;
      const text = response.text();

      const parsed = JSON.parse(text);
      const rawEntities = Array.isArray(parsed.entities) ? parsed.entities : [];

      const entities = rawEntities
        .map((raw: Record<string, unknown>) => validateEntity(raw))
        .filter((e: ExtractedEntity | null): e is ExtractedEntity => e !== null)
        .filter((e: ExtractedEntity) => e.confidence >= MIN_CONFIDENCE);

      const usage = response.usageMetadata;
      return {
        entities,
        tokensIn: usage?.promptTokenCount ?? 0,
        tokensOut: usage?.candidatesTokenCount ?? 0,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES) continue;
    }
  }

  throw lastError ?? new Error('Extraction failed after retries');
}

// Re-export for testing
export { validateEntity as _validateEntity };
