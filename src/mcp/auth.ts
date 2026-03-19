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

  return token === config.mcp.authToken;
}
