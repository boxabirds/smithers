import type pg from 'pg';
import type { ExtractedEntity } from './extractor.js';
import {
  searchSimilarEntities,
  insertEntity,
  updateEntity,
  linkEvidence,
  type EntityRow,
} from '../db/entities.js';

const DEFAULT_SIMILARITY_THRESHOLD = 0.4;

export interface MergeResult {
  created: number;
  updated: number;
  skipped: number;
}

function deduplicateWithinBatch(entities: ExtractedEntity[]): ExtractedEntity[] {
  const deduplicated: ExtractedEntity[] = [];

  for (const entity of entities) {
    const existing = deduplicated.find(
      (e) =>
        e.type === entity.type &&
        e.title.toLowerCase() === entity.title.toLowerCase(),
    );

    if (existing) {
      // Merge into existing
      existing.people = [...new Set([...existing.people, ...entity.people])];
      existing.evidenceMessageIds = [...new Set([...existing.evidenceMessageIds, ...entity.evidenceMessageIds])];
      if (entity.body && (!existing.body || entity.body.length > existing.body.length)) {
        existing.body = entity.body;
      }
      if (entity.metadata.tags) {
        existing.metadata.tags = [...new Set([...(existing.metadata.tags ?? []), ...entity.metadata.tags])];
      }
      if (entity.metadata.assignee && !existing.metadata.assignee) {
        existing.metadata.assignee = entity.metadata.assignee;
      }
    } else {
      deduplicated.push({ ...entity });
    }
  }

  return deduplicated;
}

function mergeMetadata(
  existing: Record<string, unknown>,
  incoming: ExtractedEntity['metadata'],
): Record<string, unknown> {
  const merged = { ...existing };

  if (incoming.assignee) {
    merged.assignee = incoming.assignee;
  }
  if (incoming.deadline) {
    merged.deadline = incoming.deadline;
  }
  if (incoming.url) {
    merged.url = incoming.url;
  }
  if (incoming.tags) {
    const existingTags = Array.isArray(merged.tags) ? (merged.tags as string[]) : [];
    merged.tags = [...new Set([...existingTags, ...incoming.tags])];
  }

  return merged;
}

export async function mergeEntities(
  pool: pg.Pool,
  guildId: string,
  extracted: ExtractedEntity[],
  extractionId: number,
  threshold: number = DEFAULT_SIMILARITY_THRESHOLD,
): Promise<MergeResult> {
  const deduplicated = deduplicateWithinBatch(extracted);

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const entity of deduplicated) {
    const matches = await searchSimilarEntities(pool, guildId, entity.type, entity.title, threshold);

    const now = new Date();

    if (matches.length > 0) {
      const bestMatch = matches[0];

      // Load the existing entity to merge metadata
      const existing = await pool.query('SELECT * FROM entities WHERE id = $1', [bestMatch.id]);
      if (existing.rows.length === 0) {
        skipped++;
        continue;
      }

      const existingRow = existing.rows[0] as EntityRow;
      const mergedMeta = mergeMetadata(existingRow.metadata, entity.metadata);

      await updateEntity(pool, bestMatch.id, {
        last_seen: now,
        mentions: (existingRow.mentions ?? 1) + 1,
        metadata: mergedMeta,
        ...(entity.status !== existingRow.status && entity.confidence > 0.5
          ? { status: entity.status }
          : {}),
        ...(entity.body && (!existingRow.body || entity.body.length > (existingRow.body?.length ?? 0))
          ? { body: entity.body }
          : {}),
      });

      // Link evidence
      for (const msgId of entity.evidenceMessageIds) {
        try {
          await linkEvidence(pool, bestMatch.id, msgId, extractionId);
        } catch {
          // Message ID might not exist in messages table — skip
        }
      }

      updated++;
    } else {
      const entityId = await insertEntity(pool, {
        guild_id: guildId,
        type: entity.type,
        title: entity.title,
        body: entity.body,
        status: entity.status,
        confidence: entity.confidence,
        first_seen: now,
        last_seen: now,
        mentions: 1,
        metadata: entity.metadata as Record<string, unknown>,
      });

      // Link evidence
      for (const msgId of entity.evidenceMessageIds) {
        try {
          await linkEvidence(pool, entityId, msgId, extractionId);
        } catch {
          // Message ID might not exist — skip
        }
      }

      created++;
    }
  }

  return { created, updated, skipped };
}
