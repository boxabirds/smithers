import type { Message, PartialMessage } from 'discord.js';
import type pg from 'pg';
import type { GuildConfig } from '../db/guild-config.js';
import { insertMessage, updateMessageContent, softDeleteMessage } from '../db/messages.js';

export function shouldProcessMessage(
  message: { author: { bot: boolean }; guildId: string | null; channelId: string },
  guildConfig: GuildConfig | null,
): boolean {
  if (message.author.bot) return false;
  if (!message.guildId) return false;

  if (guildConfig?.watchedChannels && guildConfig.watchedChannels.length > 0) {
    return guildConfig.watchedChannels.includes(message.channelId);
  }

  return true;
}

export async function handleMessageCreate(
  message: Message,
  pool: pg.Pool,
  guildConfig: GuildConfig | null,
): Promise<void> {
  if (!shouldProcessMessage(message, guildConfig)) return;

  try {
    await insertMessage(pool, {
      id: message.id,
      channel_id: message.channelId,
      guild_id: message.guildId!,
      author_id: message.author.id,
      author_name: message.author.username,
      content: message.content ?? '',
      created_at: message.createdAt,
      has_attachments: message.attachments.size > 0,
      reply_to_id: message.reference?.messageId ?? null,
      thread_id: message.thread?.id ?? null,
    });
  } catch (err) {
    // Log warning but do not crash the bot
    console.warn(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'warn',
      service: 'bot',
      message: `Failed to insert message ${message.id}: ${err instanceof Error ? err.message : err}`,
    }));
  }
}

export async function handleMessageUpdate(
  _oldMessage: Message | PartialMessage,
  newMessage: Message | PartialMessage,
  pool: pg.Pool,
): Promise<void> {
  if (!newMessage.content) return;

  try {
    await updateMessageContent(pool, newMessage.id, newMessage.content);
  } catch (err) {
    console.warn(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'warn',
      service: 'bot',
      message: `Failed to update message ${newMessage.id}: ${err instanceof Error ? err.message : err}`,
    }));
  }
}

export async function handleMessageDelete(
  message: Message | PartialMessage,
  pool: pg.Pool,
): Promise<void> {
  try {
    await softDeleteMessage(pool, message.id);
  } catch (err) {
    console.warn(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'warn',
      service: 'bot',
      message: `Failed to soft-delete message ${message.id}: ${err instanceof Error ? err.message : err}`,
    }));
  }
}
