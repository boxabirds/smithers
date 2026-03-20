export interface Config {
  discord: {
    token: string;
  };
  database: {
    url: string;
    poolMin: number;
    poolMax: number;
  };
  gemini: {
    apiKey: string;
    modelId: string;
  };
  extraction: {
    intervalMins: number;
  };
  mcp: {
    port: number;
    authToken: string;
  };
  logLevel: string;
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Configuration errors:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

const DEFAULT_POOL_MIN = 2;
const DEFAULT_POOL_MAX = 10;
const DEFAULT_EXTRACTION_INTERVAL_MINS = 60;
const DEFAULT_MCP_PORT = 3100;
const DEFAULT_LOG_LEVEL = 'info';
const DEFAULT_GEMINI_MODEL_ID = 'gemini-3-flash-latest';

function requireEnv(
  env: Record<string, string | undefined>,
  key: string,
  issues: string[],
): string | undefined {
  const value = env[key]?.trim();
  if (!value) {
    issues.push(`${key} is required but not set`);
    return undefined;
  }
  return value;
}

function parseIntEnv(
  env: Record<string, string | undefined>,
  key: string,
  defaultValue: number,
  issues: string[],
): number {
  const raw = env[key]?.trim();
  if (!raw) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    issues.push(`${key} must be a number, got "${raw}"`);
    return defaultValue;
  }
  return parsed;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const issues: string[] = [];

  const discordToken = requireEnv(env, 'DISCORD_TOKEN', issues);
  const databaseUrl = requireEnv(env, 'DATABASE_URL', issues);
  const geminiApiKey = requireEnv(env, 'GEMINI_API_KEY', issues);
  const mcpAuthToken = requireEnv(env, 'MCP_AUTH_TOKEN', issues);

  const poolMin = parseIntEnv(env, 'DB_POOL_MIN', DEFAULT_POOL_MIN, issues);
  const poolMax = parseIntEnv(env, 'DB_POOL_MAX', DEFAULT_POOL_MAX, issues);
  const intervalMins = parseIntEnv(env, 'EXTRACTION_INTERVAL_MINS', DEFAULT_EXTRACTION_INTERVAL_MINS, issues);
  const mcpPort = parseIntEnv(env, 'MCP_PORT', DEFAULT_MCP_PORT, issues);

  const logLevel = env['LOG_LEVEL']?.trim() || DEFAULT_LOG_LEVEL;
  const validLogLevels = ['error', 'warn', 'info', 'debug'];
  if (!validLogLevels.includes(logLevel)) {
    issues.push(`LOG_LEVEL must be one of ${validLogLevels.join(', ')}, got "${logLevel}"`);
  }

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  const config: Config = {
    discord: { token: discordToken! },
    database: { url: databaseUrl!, poolMin, poolMax },
    gemini: { apiKey: geminiApiKey!, modelId: env['GEMINI_MODEL_ID']?.trim() || DEFAULT_GEMINI_MODEL_ID },
    extraction: { intervalMins },
    mcp: { port: mcpPort, authToken: mcpAuthToken! },
    logLevel,
  };

  return Object.freeze(config) as Config;
}
