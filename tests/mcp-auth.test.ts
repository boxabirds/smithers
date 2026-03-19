import { describe, it, expect } from 'vitest';
import { validateBearerToken } from '../src/mcp/auth.js';
import type { Config } from '../src/config.js';

const config = {
  mcp: { authToken: 'test-secret', port: 3100 },
} as Config;

describe('validateBearerToken', () => {
  it('accepts valid token', () => {
    expect(validateBearerToken('Bearer test-secret', config)).toBe(true);
  });

  it('rejects invalid token', () => {
    expect(validateBearerToken('Bearer wrong-token', config)).toBe(false);
  });

  it('rejects missing header', () => {
    expect(validateBearerToken(undefined, config)).toBe(false);
    expect(validateBearerToken(null, config)).toBe(false);
  });

  it('rejects malformed header without Bearer prefix', () => {
    expect(validateBearerToken('test-secret', config)).toBe(false);
    expect(validateBearerToken('Basic test-secret', config)).toBe(false);
  });

  it('rejects empty token after Bearer', () => {
    expect(validateBearerToken('Bearer ', config)).toBe(false);
    expect(validateBearerToken('Bearer   ', config)).toBe(false);
  });
});
