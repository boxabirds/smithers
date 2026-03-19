import { describe, it, expect } from 'vitest';
import { shouldProcessMessage } from '../src/bot/events.js';
import type { GuildConfig } from '../src/db/guild-config.js';

function makeMsg(overrides: Partial<{ bot: boolean; guildId: string | null; channelId: string }> = {}) {
  return {
    author: { bot: overrides.bot ?? false },
    guildId: overrides.guildId === undefined ? '123' : overrides.guildId,
    channelId: overrides.channelId ?? '456',
  };
}

describe('shouldProcessMessage', () => {
  it('accepts human message in watched channel', () => {
    const config: GuildConfig = {
      guildId: '123', watchedChannels: ['456'], extractionIntervalMins: 60, timezone: 'UTC', promptOverrides: {},
    };
    expect(shouldProcessMessage(makeMsg(), config)).toBe(true);
  });

  it('rejects bot messages', () => {
    expect(shouldProcessMessage(makeMsg({ bot: true }), null)).toBe(false);
  });

  it('rejects message in unwatched channel', () => {
    const config: GuildConfig = {
      guildId: '123', watchedChannels: ['789'], extractionIntervalMins: 60, timezone: 'UTC', promptOverrides: {},
    };
    expect(shouldProcessMessage(makeMsg({ channelId: '456' }), config)).toBe(false);
  });

  it('accepts when no guild config (null)', () => {
    expect(shouldProcessMessage(makeMsg(), null)).toBe(true);
  });

  it('accepts when watchedChannels is null', () => {
    const config: GuildConfig = {
      guildId: '123', watchedChannels: null, extractionIntervalMins: 60, timezone: 'UTC', promptOverrides: {},
    };
    expect(shouldProcessMessage(makeMsg(), config)).toBe(true);
  });

  it('accepts when watchedChannels is empty array', () => {
    const config: GuildConfig = {
      guildId: '123', watchedChannels: [], extractionIntervalMins: 60, timezone: 'UTC', promptOverrides: {},
    };
    expect(shouldProcessMessage(makeMsg(), config)).toBe(true);
  });

  it('rejects when guildId is null (DM)', () => {
    expect(shouldProcessMessage(makeMsg({ guildId: null }), null)).toBe(false);
  });
});
