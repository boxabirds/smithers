import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLogger } from '../src/logger.js';

describe('createLogger', () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  it('outputs valid JSON', () => {
    const logger = createLogger('test-service');
    logger.info('hello');

    const call = vi.mocked(process.stdout.write).mock.calls[0][0] as string;
    const parsed = JSON.parse(call.trim());
    expect(parsed.message).toBe('hello');
  });

  it('includes service name in every entry', () => {
    const logger = createLogger('my-service');
    logger.info('test');

    const call = vi.mocked(process.stdout.write).mock.calls[0][0] as string;
    const parsed = JSON.parse(call.trim());
    expect(parsed.service).toBe('my-service');
  });

  it('includes ISO timestamp', () => {
    const logger = createLogger('svc');
    logger.info('test');

    const call = vi.mocked(process.stdout.write).mock.calls[0][0] as string;
    const parsed = JSON.parse(call.trim());
    expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('includes extra context fields', () => {
    const logger = createLogger('svc');
    logger.info('test', { userId: 123, action: 'login' });

    const call = vi.mocked(process.stdout.write).mock.calls[0][0] as string;
    const parsed = JSON.parse(call.trim());
    expect(parsed.userId).toBe(123);
    expect(parsed.action).toBe('login');
  });

  it('suppresses debug at info level', () => {
    const logger = createLogger('svc', 'info');
    logger.debug('hidden');

    expect(process.stdout.write).not.toHaveBeenCalled();
    expect(process.stderr.write).not.toHaveBeenCalled();
  });

  it('shows debug at debug level', () => {
    const logger = createLogger('svc', 'debug');
    logger.debug('visible');

    expect(process.stdout.write).toHaveBeenCalled();
    const call = vi.mocked(process.stdout.write).mock.calls[0][0] as string;
    const parsed = JSON.parse(call.trim());
    expect(parsed.level).toBe('debug');
  });

  it('writes errors to stderr', () => {
    const logger = createLogger('svc');
    logger.error('fail');

    expect(process.stderr.write).toHaveBeenCalled();
    const call = vi.mocked(process.stderr.write).mock.calls[0][0] as string;
    const parsed = JSON.parse(call.trim());
    expect(parsed.level).toBe('error');
  });
});
