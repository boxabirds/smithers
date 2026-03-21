import { timingSafeEqual } from 'node:crypto';
import type { Config } from '../config.js';

const BEARER_PREFIX = 'Bearer ';

export function validateBearerToken(
  authHeader: string | undefined | null,
  config: Config,
): boolean {
  if (!authHeader) return false;
  if (!authHeader.startsWith(BEARER_PREFIX)) return false;

  const token = authHeader.slice(BEARER_PREFIX.length).trim();
  if (!token) return false;

  const expected = config.mcp.authToken;
  if (token.length !== expected.length) return false;

  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}
