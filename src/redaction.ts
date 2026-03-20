import { redact } from '@arcjet/redact';

const REDACTED_ENTITY_TYPES = [
  'email',
  'phone-number',
  'credit-card-number',
  'ip-address',
] as const;

const REPLACEMENT = '[REDACTED]';

/**
 * Redacts common PII from message content.
 * Returns the redacted string, or the original content if redaction fails.
 */
export async function redactContent(content: string): Promise<string> {
  if (content.length === 0) return content;

  try {
    const [redacted] = await redact(content, {
      entities: REDACTED_ENTITY_TYPES,
      replace: () => REPLACEMENT,
    });
    return redacted;
  } catch (err) {
    console.warn(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'warn',
      service: 'redaction',
      message: `Redaction failed, storing original content: ${err instanceof Error ? err.message : err}`,
    }));
    return content;
  }
}
