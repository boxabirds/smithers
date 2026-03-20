import type pg from 'pg';
import type { Config } from '../config.js';
import type { MessageRow } from '../db/messages.js';
import { markStaleEntities, getAllEntityContext } from '../db/entities.js';
import { extractEntities } from './extractor.js';
import { mergeEntities } from './merger.js';

// Gemini Flash pricing (approximate — will be replaced by OpenRouter lookup in story 11)
const INPUT_PRICE_PER_TOKEN = 0.30 / 1_000_000;
const OUTPUT_PRICE_PER_TOKEN = 2.50 / 1_000_000;

const STALENESS_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const QUIET_PERIOD_MS = 5 * 60 * 1000; // 5 minutes of silence before extraction
const CHECK_INTERVAL_MS = 60 * 1000; // check every 60 seconds

export interface ExtractionRunResult {
  guildId: string;
  messageCount: number;
  entitiesCreated: number;
  entitiesUpdated: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export async function logExtractionRun(
  pool: pg.Pool,
  run: {
    guildId: string;
    channelId: string | null;
    windowStart: Date;
    windowEnd: Date;
    messageCount: number;
    model: string;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
  },
): Promise<number> {
  const result = await pool.query(
    `INSERT INTO extraction_runs (guild_id, channel_id, window_start, window_end, message_count, model, tokens_in, tokens_out, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [run.guildId, run.channelId, run.windowStart, run.windowEnd, run.messageCount, run.model, run.tokensIn, run.tokensOut, run.costUsd],
  );
  return result.rows[0].id as number;
}

export function calculateCost(tokensIn: number, tokensOut: number): number {
  return tokensIn * INPUT_PRICE_PER_TOKEN + tokensOut * OUTPUT_PRICE_PER_TOKEN;
}

async function getLastWindowEnd(pool: pg.Pool, guildId: string): Promise<Date | null> {
  const result = await pool.query(
    `SELECT window_end FROM extraction_runs WHERE guild_id = $1 ORDER BY window_end DESC LIMIT 1`,
    [guildId],
  );
  if (result.rows.length === 0) return null;
  return result.rows[0].window_end as Date;
}

async function getMessagesInWindow(
  pool: pg.Pool,
  guildId: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<MessageRow[]> {
  const result = await pool.query(
    `SELECT id, channel_id, guild_id, author_id, author_name, content, created_at, has_attachments, reply_to_id, thread_id
     FROM messages
     WHERE guild_id = $1 AND created_at >= $2 AND created_at < $3 AND deleted_at IS NULL
     ORDER BY created_at ASC`,
    [guildId, windowStart, windowEnd],
  );
  return result.rows as MessageRow[];
}

export async function runExtractionCycle(
  pool: pg.Pool,
  guildId: string,
  config: Config,
): Promise<ExtractionRunResult | null> {
  const now = new Date();
  const lastEnd = await getLastWindowEnd(pool, guildId);

  let windowStart: Date;
  if (lastEnd) {
    windowStart = lastEnd;
  } else {
    const earliest = await pool.query(
      `SELECT MIN(created_at) AS min_time FROM messages WHERE guild_id = $1`,
      [guildId],
    );
    if (!earliest.rows[0]?.min_time) return null;
    windowStart = earliest.rows[0].min_time as Date;
  }

  const messages = await getMessagesInWindow(pool, guildId, windowStart, now);
  if (messages.length === 0) return null;

  // Fetch full entity context for the guild
  const entityContext = await getAllEntityContext(pool, guildId);

  // Log the run first to get an extraction ID
  const runId = await logExtractionRun(pool, {
    guildId,
    channelId: null,
    windowStart,
    windowEnd: now,
    messageCount: messages.length,
    model: config.gemini.modelId,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
  });

  // Single extraction call with full entity context
  const result = await extractEntities(messages, config, entityContext);
  const mergeResult = await mergeEntities(pool, guildId, result.entities, runId);

  const totalCost = calculateCost(result.tokensIn, result.tokensOut);

  // Update the run with actual token counts and cost
  await pool.query(
    `UPDATE extraction_runs SET tokens_in = $1, tokens_out = $2, cost_usd = $3 WHERE id = $4`,
    [result.tokensIn, result.tokensOut, totalCost, runId],
  );

  return {
    guildId,
    messageCount: messages.length,
    entitiesCreated: mergeResult.created,
    entitiesUpdated: mergeResult.updated,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    costUsd: totalCost,
  };
}

// ─── Extraction Semaphore ────────────────────────────────────────

interface LockEntry {
  promise: Promise<void>;
  resolve: () => void;
}

const extractionLocks = new Map<string, LockEntry>();

function acquireExtractionLock(guildId: string): void {
  let resolve: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  extractionLocks.set(guildId, { promise, resolve: resolve! });
}

function releaseExtractionLock(guildId: string): void {
  const lock = extractionLocks.get(guildId);
  if (lock) {
    lock.resolve();
    extractionLocks.delete(guildId);
  }
}

/**
 * Awaits any in-progress extraction for the given guild.
 * Returns immediately if no extraction is running.
 * Used by slash command handlers to ensure fresh data.
 */
export async function awaitExtractionLock(guildId: string): Promise<void> {
  const lock = extractionLocks.get(guildId);
  if (lock) {
    await lock.promise;
  }
}

// ─── Event-Driven Scheduling ─────────────────────────────────────

const lastMessageTime = new Map<string, number>();
const lastExtractionTime = new Map<string, number>();

/**
 * Called from events.ts on each incoming message.
 * Updates the last message timestamp for the guild.
 */
export function notifyMessageReceived(guildId: string): void {
  lastMessageTime.set(guildId, Date.now());
}

export interface SchedulerHandle {
  stop: () => void;
}

export function startScheduler(config: Config, pool: pg.Pool): SchedulerHandle {
  const maxCeilingMs = config.extraction.intervalMins * 60 * 1000;
  let running = true;

  const checkAndTrigger = async () => {
    if (!running) return;

    const guilds = await pool.query('SELECT guild_id FROM guild_config');
    const now = Date.now();

    for (const row of guilds.rows) {
      if (!running) break;
      const guildId = String(row.guild_id);

      // Skip if extraction is already running for this guild
      if (extractionLocks.has(guildId)) continue;

      const lastMsg = lastMessageTime.get(guildId) ?? 0;
      const lastExtract = lastExtractionTime.get(guildId) ?? 0;

      // No new messages since last extraction
      if (lastMsg <= lastExtract) continue;

      const quietElapsed = now - lastMsg >= QUIET_PERIOD_MS;
      const ceilingReached = lastExtract > 0 && (now - lastExtract >= maxCeilingMs);
      const firstRun = lastExtract === 0;

      if (!quietElapsed && !ceilingReached && !firstRun) continue;

      // Trigger extraction
      acquireExtractionLock(guildId);
      try {
        const result = await runExtractionCycle(pool, guildId, config);
        lastExtractionTime.set(guildId, Date.now());
        if (result) {
          console.log(JSON.stringify({
            timestamp: new Date().toISOString(),
            level: 'info',
            service: 'extraction',
            message: `Extraction complete for guild ${result.guildId}: ${result.messageCount} messages, ${result.entitiesCreated} created, ${result.entitiesUpdated} updated, $${result.costUsd.toFixed(4)} cost`,
          }));
        }
      } catch (err) {
        console.error(JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'error',
          service: 'extraction',
          message: `Extraction failed for guild ${guildId}: ${err instanceof Error ? err.message : err}`,
        }));
      } finally {
        releaseExtractionLock(guildId);
      }
    }
  };

  const checkTimer = setInterval(checkAndTrigger, CHECK_INTERVAL_MS);

  // Staleness check runs daily
  const stalenessTimer = setInterval(async () => {
    if (!running) return;
    try {
      const count = await markStaleEntities(pool);
      if (count > 0) {
        console.log(JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'info',
          service: 'extraction',
          message: `Marked ${count} entities as stale`,
        }));
      }
    } catch (err) {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        service: 'extraction',
        message: `Staleness check failed: ${err instanceof Error ? err.message : err}`,
      }));
    }
  }, STALENESS_CHECK_INTERVAL_MS);

  // Run first check immediately
  checkAndTrigger();

  return {
    stop: () => {
      running = false;
      clearInterval(checkTimer);
      clearInterval(stalenessTimer);
    },
  };
}
