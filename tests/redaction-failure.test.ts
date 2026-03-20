import { describe, it, expect, vi } from 'vitest';

vi.mock('@arcjet/redact', () => ({
  redact: () => { throw new Error('WASM init failed'); },
}));

describe('redactContent graceful failure', () => {
  it('returns original content and logs warning when @arcjet/redact throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { redactContent } = await import('../src/redaction.js');
    const original = 'my email is alice@example.com';
    const result = await redactContent(original);

    expect(result).toBe(original);
    expect(warnSpy).toHaveBeenCalledOnce();
    const loggedMessage = warnSpy.mock.calls[0][0] as string;
    expect(loggedMessage).toContain('Redaction failed');
    expect(loggedMessage).toContain('WASM init failed');

    warnSpy.mockRestore();
  });
});
