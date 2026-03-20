import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from '../src/config.js';

const validEnv = {
  DISCORD_TOKEN: 'test-token',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  GEMINI_API_KEY: 'gemini-key',
  MCP_AUTH_TOKEN: 'mcp-secret',
};

describe('loadConfig', () => {
  it('returns frozen Config with valid env', () => {
    const config = loadConfig(validEnv);
    expect(config.discord.token).toBe('test-token');
    expect(config.database.url).toBe('postgres://user:pass@localhost:5432/db');
    expect(config.gemini.apiKey).toBe('gemini-key');
    expect(config.mcp.authToken).toBe('mcp-secret');
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('applies defaults for optional fields', () => {
    const config = loadConfig(validEnv);
    expect(config.database.poolMin).toBe(2);
    expect(config.database.poolMax).toBe(10);
    expect(config.extraction.intervalMins).toBe(60);
    expect(config.mcp.port).toBe(3100);
    expect(config.logLevel).toBe('info');
  });

  it('overrides defaults when optional fields set', () => {
    const config = loadConfig({
      ...validEnv,
      DB_POOL_MIN: '5',
      DB_POOL_MAX: '20',
      EXTRACTION_INTERVAL_MINS: '30',
      MCP_PORT: '4000',
      LOG_LEVEL: 'debug',
    });
    expect(config.database.poolMin).toBe(5);
    expect(config.database.poolMax).toBe(20);
    expect(config.extraction.intervalMins).toBe(30);
    expect(config.mcp.port).toBe(4000);
    expect(config.logLevel).toBe('debug');
  });

  it('throws ConfigError listing missing required var', () => {
    const env = { ...validEnv };
    delete (env as Record<string, string | undefined>).DISCORD_TOKEN;
    expect(() => loadConfig(env)).toThrow(ConfigError);
    try {
      loadConfig(env);
    } catch (e) {
      expect((e as ConfigError).issues).toContain('DISCORD_TOKEN is required but not set');
    }
  });

  it('reports all missing vars in single error', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    try {
      loadConfig({});
    } catch (e) {
      const issues = (e as ConfigError).issues;
      expect(issues.length).toBeGreaterThanOrEqual(4);
      expect(issues).toContain('DISCORD_TOKEN is required but not set');
      expect(issues).toContain('DATABASE_URL is required but not set');
      expect(issues).toContain('GEMINI_API_KEY is required but not set');
      expect(issues).toContain('MCP_AUTH_TOKEN is required but not set');
    }
  });

  it('rejects non-numeric port value', () => {
    expect(() => loadConfig({ ...validEnv, MCP_PORT: 'abc' })).toThrow(ConfigError);
    try {
      loadConfig({ ...validEnv, MCP_PORT: 'abc' });
    } catch (e) {
      expect((e as ConfigError).issues).toContain('MCP_PORT must be a number, got "abc"');
    }
  });

  it('rejects invalid log level', () => {
    expect(() => loadConfig({ ...validEnv, LOG_LEVEL: 'verbose' })).toThrow(ConfigError);
  });

  it('trims whitespace from values', () => {
    const config = loadConfig({ ...validEnv, DISCORD_TOKEN: '  my-token  ' });
    expect(config.discord.token).toBe('my-token');
  });

  it('treats empty string as missing', () => {
    expect(() => loadConfig({ ...validEnv, DISCORD_TOKEN: '' })).toThrow(ConfigError);
  });

  it('treats whitespace-only as missing', () => {
    expect(() => loadConfig({ ...validEnv, DISCORD_TOKEN: '   ' })).toThrow(ConfigError);
  });

  it('ignores extra env vars', () => {
    const config = loadConfig({ ...validEnv, UNKNOWN_VAR: 'whatever' });
    expect(config.discord.token).toBe('test-token');
  });

  it('defaults GEMINI_MODEL_ID to gemini-3-flash-latest', () => {
    const config = loadConfig(validEnv);
    expect(config.gemini.modelId).toBe('gemini-3-flash-latest');
  });

  it('reads GEMINI_MODEL_ID from env when set', () => {
    const config = loadConfig({ ...validEnv, GEMINI_MODEL_ID: 'gemini-4-flash' });
    expect(config.gemini.modelId).toBe('gemini-4-flash');
  });
});
