import { GoogleGenerativeAI } from '@google/generative-ai';
import type { Config } from '../config.js';
import type { MessageRow } from '../db/messages.js';
import { buildExtractionPrompt } from './prompts.js';

const MODEL_NAME = 'gemini-2.5-flash';
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
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  tokensIn: number;
  tokensOut: number;
}

const VALID_TYPES = new Set(['project', 'action', 'question', 'decision', 'concept', 'resource']);
const VALID_STATUSES = new Set(['open', 'resolved', 'closed']);

function validateEntity(raw: Record<string, unknown>): ExtractedEntity | null {
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

export async function extractEntities(
  messages: MessageRow[],
  config: Config,
): Promise<ExtractionResult> {
  const genAI = new GoogleGenerativeAI(config.gemini.apiKey);
  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    generationConfig: {
      responseMimeType: 'application/json',
    },
  });

  const prompt = buildExtractionPrompt(messages);
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await model.generateContent(prompt);
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
