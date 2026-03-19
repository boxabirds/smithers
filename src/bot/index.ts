import { Client, Events, GatewayIntentBits } from 'discord.js';
import type pg from 'pg';
import type { Config } from '../config.js';
import { ensureGuildConfig, loadGuildConfig } from '../db/guild-config.js';
import { handleMessageCreate, handleMessageUpdate, handleMessageDelete } from './events.js';
import { backfillGuild } from './backfill.js';
import { registerCommands } from './commands/register.js';
import { handleSlashCommand } from './commands/index.js';

// Cache guild configs to avoid DB lookups on every message
const guildConfigCache = new Map<string, Awaited<ReturnType<typeof loadGuildConfig>>>();

export async function startBot(config: Config, pool: pg.Pool): Promise<Client> {
  const botStartTime = new Date();
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once(Events.ClientReady, async (readyClient) => {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'info',
      service: 'bot',
      message: `Bot ready as ${readyClient.user.tag}`,
      guilds: readyClient.guilds.cache.size,
    }));

    // Register slash commands
    try {
      await registerCommands(readyClient.user.id, config.discord.token);
    } catch (err) {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        service: 'bot',
        message: `Failed to register slash commands: ${err instanceof Error ? err.message : err}`,
      }));
    }

    // Ensure guild configs and backfill for each guild
    for (const [guildId] of readyClient.guilds.cache) {
      try {
        const guildConfig = await ensureGuildConfig(pool, guildId);
        guildConfigCache.set(guildId, guildConfig);

        const result = await backfillGuild(client, pool, guildConfig, guildId);
        console.log(JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'info',
          service: 'bot',
          message: `Backfill complete for guild ${guildId}: ${result.channelsProcessed} channels, ${result.messagesInserted} new messages`,
          guildId,
        }));
      } catch (err) {
        console.error(JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'error',
          service: 'bot',
          message: `Failed to initialize guild ${guildId}: ${err instanceof Error ? err.message : err}`,
          guildId,
        }));
      }
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    const guildConfig = message.guildId ? guildConfigCache.get(message.guildId) ?? null : null;
    await handleMessageCreate(message, pool, guildConfig);
  });

  client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
    await handleMessageUpdate(oldMessage, newMessage, pool);
  });

  client.on(Events.MessageDelete, async (message) => {
    await handleMessageDelete(message, pool);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    await handleSlashCommand(interaction, pool, botStartTime);
  });

  client.on(Events.GuildCreate, async (guild) => {
    const guildConfig = await ensureGuildConfig(pool, guild.id);
    guildConfigCache.set(guild.id, guildConfig);
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'info',
      service: 'bot',
      message: `Joined guild ${guild.name} (${guild.id})`,
    }));
  });

  await client.login(config.discord.token);

  return client;
}

export async function stopBot(client: Client): Promise<void> {
  client.destroy();
}
