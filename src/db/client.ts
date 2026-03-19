import pg from 'pg';
import type { Config } from '../config.js';

const SHUTDOWN_TIMEOUT_MS = 5000;

export function createPool(config: Config): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.database.url,
    min: config.database.poolMin,
    max: config.database.poolMax,
  });

  return pool;
}

export async function verifyConnection(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
}

export async function shutdownPool(pool: pg.Pool): Promise<void> {
  const timeout = new Promise<void>((resolve) =>
    setTimeout(() => resolve(), SHUTDOWN_TIMEOUT_MS),
  );
  await Promise.race([pool.end(), timeout]);
}
