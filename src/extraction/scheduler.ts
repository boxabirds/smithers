import type pg from 'pg';
import type { Config } from '../config.js';
import type { MessageRow } from '../db/messages.js';
import { markStaleEntities } from '../db/entities.js';
import { chunkMessages } from './chunker.js';
import { extractEntities } from './extractor.js';
import { mergeEntities } from './merger.js';

// Gemini Flash pricing
const INPUT_PRICE_PER_TOKEN = 0.10 / 1_000_000;
const OUTPUT_PRICE_PER_TOKEN = 0.40 / 1_000_000;
const STALENESS_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

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
    // First run: start from earliest message
    const earliest = await pool.query(
      `SELECT MIN(created_at) AS min_time FROM messages WHERE guild_id = $1`,
      [guildId],
    );
    if (!earliest.rows[0]?.min_time) return null;
    windowStart = earliest.rows[0].min_time as Date;
  }

  const messages = await getMessagesInWindow(pool, guildId, windowStart, now);
  if (messages.length === 0) return null;

  const chunks = chunkMessages(messages);
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalCreated = 0;
  let totalUpdated = 0;

  // Log the run first to get an extraction ID
  const costEstimate = 0; // will update after
  const runId = await logExtractionRun(pool, {
    guildId,
    channelId: null,
    windowStart,
    windowEnd: now,
    messageCount: messages.length,
    model: 'gemini-2.5-flash',
    tokensIn: 0,
    tokensOut: 0,
    costUsd: costEstimate,
  });

  for (const chunk of chunks) {
    const result = await extractEntities(chunk, config);
    totalTokensIn += result.tokensIn;
    totalTokensOut += result.tokensOut;

    const mergeResult = await mergeEntities(pool, guildId, result.entities, runId);
    totalCreated += mergeResult.created;
    totalUpdated += mergeResult.updated;
  }

  const totalCost = calculateCost(totalTokensIn, totalTokensOut);

  // Update the run with actual token counts and cost
  await pool.query(
    `UPDATE extraction_runs SET tokens_in = $1, tokens_out = $2, cost_usd = $3 WHERE id = $4`,
    [totalTokensIn, totalTokensOut, totalCost, runId],
  );

  return {
    guildId,
    messageCount: messages.length,
    entitiesCreated: totalCreated,
    entitiesUpdated: totalUpdated,
    tokensIn: totalTokensIn,
    tokensOut: totalTokensOut,
    costUsd: totalCost,
  };
}

export interface SchedulerHandle {
  stop: () => void;
}

export function startScheduler(config: Config, pool: pg.Pool): SchedulerHandle {
  const intervalMs = config.extraction.intervalMins * 60 * 1000;
  let running = true;

  const runCycle = async () => {
    if (!running) return;

    const guilds = await pool.query('SELECT guild_id FROM guild_config');
    for (const row of guilds.rows) {
      if (!running) break;
      try {
        const result = await runExtractionCycle(pool, String(row.guild_id), config);
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
          message: `Extraction failed for guild ${row.guild_id}: ${err instanceof Error ? err.message : err}`,
        }));
        // Don't advance window — next cycle will retry
      }
    }
  };

  const extractionTimer = setInterval(runCycle, intervalMs);

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

  // Run first cycle immediately
  runCycle();

  return {
    stop: () => {
      running = false;
      clearInterval(extractionTimer);
      clearInterval(stalenessTimer);
    },
  };
}
