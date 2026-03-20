import { describe, it, expect, vi } from 'vitest';
import { redactContent } from '../src/redaction.js';

describe('redactContent', () => {
  // --- Single PII types ---

  it('redacts email addresses', async () => {
    const result = await redactContent('contact me at alice@example.com thanks');
    expect(result).toBe('contact me at [REDACTED] thanks');
    expect(result).not.toContain('alice@example.com');
  });

  it('redacts phone numbers', async () => {
    const result = await redactContent('call me at 555-123-4567');
    expect(result).not.toContain('555-123-4567');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts credit card numbers', async () => {
    const result = await redactContent('my card is 4111 1111 1111 1111');
    expect(result).not.toContain('4111');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts credit card numbers with dashes', async () => {
    const result = await redactContent('card: 4111-1111-1111-1111');
    expect(result).not.toContain('4111');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts IPv4 addresses', async () => {
    const result = await redactContent('server is at 192.168.1.100');
    expect(result).not.toContain('192.168.1.100');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts IPv6 addresses', async () => {
    const result = await redactContent('host: 2001:0db8:85a3:0000:0000:8a2e:0370:7334');
    expect(result).not.toContain('2001:0db8');
    expect(result).toContain('[REDACTED]');
  });

  // --- International phone formats ---

  it('redacts international phone numbers with country code', async () => {
    const result = await redactContent('UK number: +44 20 7946 0958');
    expect(result).not.toContain('7946');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts US phone numbers with country code', async () => {
    const result = await redactContent('call +1 555 123 4567');
    expect(result).not.toContain('555');
    expect(result).toContain('[REDACTED]');
  });

  // --- Multiple PII types ---

  it('redacts multiple PII types in one message', async () => {
    const result = await redactContent('email bob@test.com or call 555-867-5309 from 10.0.0.1');
    expect(result).not.toContain('bob@test.com');
    expect(result).not.toContain('555-867-5309');
    expect(result).not.toContain('10.0.0.1');
  });

  // --- No PII ---

  it('passes through content with no PII', async () => {
    const input = 'just a normal message about the project';
    const result = await redactContent(input);
    expect(result).toBe(input);
  });

  // --- Edge cases ---

  it('returns empty string unchanged', async () => {
    const result = await redactContent('');
    expect(result).toBe('');
  });

  it('handles PII-only message', async () => {
    const result = await redactContent('alice@example.com');
    expect(result).not.toContain('alice@example.com');
    expect(result).toContain('[REDACTED]');
  });

  it('handles PII at start of message', async () => {
    const result = await redactContent('alice@example.com is my email');
    expect(result).not.toContain('alice@example.com');
    expect(result).toContain('[REDACTED]');
  });

  it('handles PII at end of message', async () => {
    const result = await redactContent('my email is alice@example.com');
    expect(result).not.toContain('alice@example.com');
    expect(result).toContain('[REDACTED]');
  });

  // --- Username preservation ---

  it('preserves Discord username mentions', async () => {
    const result = await redactContent('@julian said to email alice@example.com');
    expect(result).toContain('@julian');
    expect(result).not.toContain('alice@example.com');
  });

  it('preserves display names in conversation', async () => {
    const result = await redactContent('julian: send it to test@example.com');
    expect(result).toContain('julian');
    expect(result).not.toContain('test@example.com');
  });

});
