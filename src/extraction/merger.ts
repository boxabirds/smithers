import type pg from 'pg';
import type { ExtractedEntity } from './extractor.js';
import {
  searchSimilarEntities,
  insertEntity,
  updateEntity,
  linkEvidence,
  getEntityById,
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
    // Dedup by resolves_existing_id first
    if (entity.resolvesExistingId !== undefined) {
      const existingUpdate = deduplicated.find(
        (e) => e.resolvesExistingId === entity.resolvesExistingId,
      );
      if (existingUpdate) {
        // Keep higher confidence, merge evidence
        existingUpdate.evidenceMessageIds = [...new Set([...existingUpdate.evidenceMessageIds, ...entity.evidenceMessageIds])];
        if (entity.confidence > existingUpdate.confidence) {
          existingUpdate.confidence = entity.confidence;
          existingUpdate.status = entity.status;
        }
        if (entity.body && (!existingUpdate.body || entity.body.length > existingUpdate.body.length)) {
          existingUpdate.body = entity.body;
        }
        continue;
      }
      deduplicated.push({ ...entity });
      continue;
    }

    // Dedup new entities by type + title
    const existing = deduplicated.find(
      (e) =>
        e.resolvesExistingId === undefined &&
        e.type === entity.type &&
        e.title.toLowerCase() === entity.title.toLowerCase(),
    );

    if (existing) {
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
    const now = new Date();

    // Direct update path: entity references an existing entity by ID
    if (entity.resolvesExistingId !== undefined) {
      const existing = await getEntityById(pool, entity.resolvesExistingId, true);

      if (!existing) {
        console.warn(JSON.stringify({
          timestamp: now.toISOString(),
          level: 'warn',
          service: 'extraction',
          message: `resolves_existing_id ${entity.resolvesExistingId} not found, skipping update`,
        }));
        skipped++;
        continue;
      }

      if (existing.deleted_at) {
        console.warn(JSON.stringify({
          timestamp: now.toISOString(),
          level: 'warn',
          service: 'extraction',
          message: `resolves_existing_id ${entity.resolvesExistingId} is deleted, skipping update`,
        }));
        skipped++;
        continue;
      }

      if (existing.guild_id !== guildId) {
        console.warn(JSON.stringify({
          timestamp: now.toISOString(),
          level: 'warn',
          service: 'extraction',
          message: `resolves_existing_id ${entity.resolvesExistingId} belongs to different guild, skipping update`,
        }));
        skipped++;
        continue;
      }

      await updateEntity(pool, entity.resolvesExistingId, {
        last_seen: now,
        mentions: (existing.mentions ?? 1) + 1,
        ...(entity.status !== existing.status && entity.confidence > 0.5
          ? { status: entity.status }
          : {}),
        ...(entity.body && (!existing.body || entity.body.length > (existing.body?.length ?? 0))
          ? { body: entity.body }
          : {}),
      });

      for (const msgId of entity.evidenceMessageIds) {
        try {
          await linkEvidence(pool, entity.resolvesExistingId, msgId, extractionId);
        } catch {
          // Message ID might not exist — skip
        }
      }

      updated++;
      continue;
    }

    // Similarity-based path: search for existing entities by title
    const matches = await searchSimilarEntities(pool, guildId, entity.type, entity.title, threshold);

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
