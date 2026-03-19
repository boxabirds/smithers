import type { Client, TextChannel, NewsChannel } from 'discord.js';
import { ChannelType } from 'discord.js';
import type pg from 'pg';
import type { GuildConfig } from '../db/guild-config.js';
import { batchInsertMessages } from '../db/messages.js';
import type { MessageRow } from '../db/messages.js';

const BACKFILL_LIMIT = 1000;
const FETCH_PAGE_SIZE = 100;

export interface BackfillResult {
  channelsProcessed: number;
  messagesInserted: number;
}

export async function backfillGuild(
  client: Client,
  pool: pg.Pool,
  guildConfig: GuildConfig | null,
  guildId: string,
): Promise<BackfillResult> {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return { channelsProcessed: 0, messagesInserted: 0 };

  const allChannels = guild.channels.cache.filter(
    (ch) => ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildNews,
  );

  const channelList = guildConfig?.watchedChannels && guildConfig.watchedChannels.length > 0
    ? allChannels.filter((ch) => guildConfig.watchedChannels!.includes(ch.id))
    : allChannels;

  let totalInserted = 0;
  let channelsProcessed = 0;

  for (const [, channel] of channelList) {
    try {
      const textChannel = channel as TextChannel | NewsChannel;
      const messages: MessageRow[] = [];
      let lastId: string | undefined;
      let fetched = 0;

      while (fetched < BACKFILL_LIMIT) {
        const batch = await textChannel.messages.fetch({
          limit: FETCH_PAGE_SIZE,
          ...(lastId ? { before: lastId } : {}),
        });

        if (batch.size === 0) break;

        for (const [, msg] of batch) {
          if (msg.author.bot) continue;
          messages.push({
            id: msg.id,
            channel_id: msg.channelId,
            guild_id: msg.guildId!,
            author_id: msg.author.id,
            author_name: msg.author.username,
            content: msg.content ?? '',
            created_at: msg.createdAt,
            has_attachments: msg.attachments.size > 0,
            reply_to_id: msg.reference?.messageId ?? null,
            thread_id: msg.thread?.id ?? null,
          });
        }

        lastId = batch.last()?.id;
        fetched += batch.size;

        if (batch.size < FETCH_PAGE_SIZE) break;
      }

      if (messages.length > 0) {
        const inserted = await batchInsertMessages(pool, messages);
        totalInserted += inserted;
      }
      channelsProcessed++;

      console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'info',
        service: 'bot',
        message: `Backfilled channel ${textChannel.name}: ${messages.length} fetched, new messages inserted`,
        channelId: textChannel.id,
      }));
    } catch (err) {
      // Permission errors or other per-channel failures: log and skip
      console.warn(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'warn',
        service: 'bot',
        message: `Failed to backfill channel ${channel.id}: ${err instanceof Error ? err.message : err}`,
        channelId: channel.id,
      }));
    }
  }

  return { channelsProcessed, messagesInserted: totalInserted };
}
