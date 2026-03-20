# Discord Secretary

An always-on Discord bot that monitors channel conversations, builds a cumulative knowledge base, and exposes structured insights to both Discord users (via slash commands) and coding agents (via MCP).

---

## Table of Contents

- [How It Works](#how-it-works)
- [Installation](#installation)
  - [Prerequisites](#prerequisites)
  - [Discord Bot Setup](#discord-bot-setup)
  - [Local Development](#local-development)
  - [Production Deployment](#production-deployment)
- [Configuration](#configuration)
- [Usage](#usage)
  - [Discord Slash Commands](#discord-slash-commands)
  - [MCP Tools for Coding Agents](#mcp-tools-for-coding-agents)
  - [Correcting Extraction Mistakes](#correcting-extraction-mistakes)
- [Entity Types](#entity-types)
- [Architecture](#architecture)
  - [Extraction Pipeline](#extraction-pipeline)
  - [Entity Merging](#entity-merging)
  - [Database Schema](#database-schema)
- [Maintenance](#maintenance)
  - [Monitoring](#monitoring)
  - [Backup and Restore](#backup-and-restore)
  - [Resetting State](#resetting-state)
  - [Re-extracting from History](#re-extracting-from-history)
  - [Cost Tracking](#cost-tracking)
- [Exporting Data](#exporting-data)
- [Testing](#testing)
- [Costs](#costs)
- [Documentation](#documentation)

---

## How It Works

1. **Ingestion** — The bot connects to Discord via WebSocket and writes every message to PostgreSQL. No LLM calls on the hot path. On startup, it backfills the last 1,000 messages per channel to cover any gaps from downtime.

2. **Extraction** — A scheduled worker (default: every 60 minutes) reads unprocessed messages, chunks them into batches of ~75, and sends each batch to Gemini Flash for structured entity extraction. It identifies projects, actions, decisions, questions, concepts, and resources.

3. **Entity Merging** — Extracted entities are matched against existing ones using trigram text similarity (`pg_trgm`). Matches update existing entities (incrementing mention counts, merging metadata); new entities are inserted. Entities not seen in 14+ days are automatically marked stale.

4. **Querying** — Discord users query the knowledge base via slash commands (`/actions`, `/digest`, etc.). Coding agents query via MCP tools (`search_knowledge`, `get_actions`, etc.).

5. **Correction** — Users fix extraction mistakes via `/correct` commands. Corrections are audit-logged and (in a future release) feed back into the extraction prompt to improve accuracy over time.

---

## Installation

### Prerequisites

- [Node.js 22+](https://nodejs.org/)
- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- A Discord account with permission to create bots
- A [Google AI Studio](https://ai.google.dev/) account for the Gemini API key

### Discord Bot Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications) and create a new application.

2. Navigate to **Bot** and click **Reset Token** to get your bot token. Save it — you'll need it for `DISCORD_TOKEN`.

3. Under **Privileged Gateway Intents**, enable **Message Content Intent**. This is required for the bot to read message content.

4. Navigate to **OAuth2 > URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: `Read Message History`, `View Channels`, `Send Messages`, `Use Slash Commands`

5. Copy the generated URL and open it in your browser to invite the bot to your server.

### Local Development

```bash
# Clone the repository
git clone git@github.com:boxabirds/smithers.git
cd smithers

# Copy and configure environment
cp .env.example .env
# Edit .env — fill in DISCORD_TOKEN, GEMINI_API_KEY, MCP_AUTH_TOKEN, PG_PASSWORD

# Start PostgreSQL
docker compose up postgres -d

# Wait for PostgreSQL to be healthy, then run the bot
npm install
npx tsx src/index.ts
```

The bot will:
1. Load and validate configuration
2. Connect to PostgreSQL and run migrations
3. Connect to Discord and register slash commands
4. Backfill recent messages from all accessible channels
5. Start the extraction scheduler
6. Log `Ready` when everything is up

### Production Deployment

```bash
# On your Hetzner VPS (or any Docker host):
git clone git@github.com:boxabirds/smithers.git
cd smithers
cp .env.example .env
# Edit .env with production credentials

# Start all services (without Cloudflare Tunnel)
docker compose up -d

# Start with Cloudflare Tunnel for public HTTPS access
docker compose --profile production up -d
```

For Cloudflare Tunnel setup, see [docs/deployment.md](docs/deployment.md).

---

## Configuration

All configuration is via environment variables. See [`.env.example`](.env.example) for the full list.

### Required

| Variable | Description |
|----------|-------------|
| `DISCORD_TOKEN` | Bot token from Discord Developer Portal |
| `DATABASE_URL` | PostgreSQL connection string (e.g., `postgres://secretary:pass@localhost:5432/secretary`) |
| `GEMINI_API_KEY` | API key from Google AI Studio |
| `MCP_AUTH_TOKEN` | Shared secret for authenticating MCP tool calls |
| `PG_PASSWORD` | PostgreSQL password (used by Docker Compose) |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_POOL_MIN` | `2` | Minimum database connections |
| `DB_POOL_MAX` | `10` | Maximum database connections |
| `EXTRACTION_INTERVAL_MINS` | `60` | Minutes between extraction cycles |
| `MCP_PORT` | `3100` | Port for the MCP server |
| `LOG_LEVEL` | `info` | Logging level: `error`, `warn`, `info`, `debug` |
| `CF_TUNNEL_TOKEN` | — | Cloudflare Tunnel token (production only) |

---

## Usage

### Discord Slash Commands

Once the bot is in your server, these commands are available to all members:

| Command | Parameters | What it does |
|---------|------------|--------------|
| `/actions` | `assignee` (optional) | Show open action items. Filter by person if needed. |
| `/questions` | — | Show unanswered questions. |
| `/digest` | `days` (optional, default 7) | Activity summary: how many projects, actions, decisions, etc. in the last N days. |
| `/projects` | — | Show active projects. |
| `/decisions` | `days` (optional, default 7) | Show recent decisions. |
| `/status` | — | Bot health: uptime, total messages captured, total entities extracted. |
| `/search` | `query` (required) | Full-text search across all entity types. Returns entity IDs for use with `/correct`. |

All responses appear as rich Discord embeds. Empty states show helpful messages rather than errors.

### MCP Tools for Coding Agents

The MCP server runs on port 3100 (configurable) and exposes 7 tools. Connect from Claude Code, Cursor, or any MCP-compatible client.

**Authentication:** Include `Authorization: Bearer <MCP_AUTH_TOKEN>` in the connection.

**Health check:** `GET /health` returns `{"status":"ok","tools":7}`.

**Claude Code configuration** (`~/.claude/mcp.json`):
```json
{
  "servers": {
    "discord-secretary": {
      "url": "http://localhost:3100/sse",
      "headers": {
        "Authorization": "Bearer your-mcp-auth-token"
      }
    }
  }
}
```

#### Tool Reference

**`search_knowledge`** — Free-text search across all entity types.
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | yes | — | Search query |
| `type` | string | no | — | Filter: project, action, question, decision, concept, resource |
| `status` | string | no | — | Filter: open, resolved, closed, stale |
| `since` | ISO date | no | — | Only entities seen after this date |
| `limit` | number | no | 20 | Max results |

**`get_actions`** — Open action items.
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `assignee` | string | no | — | Filter by person |
| `status` | string | no | open | open, stale, or all |
| `since` | ISO date | no | — | Only actions seen after this date |

**`get_open_questions`** — Unanswered questions.
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `since` | ISO date | no | — | Only questions seen after this date |
| `channel` | string | no | — | Filter by Discord channel ID |

**`get_projects`** — Project summaries.
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `status` | string | no | all | active, stale, or all |

**`get_decisions`** — Recent decisions.
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `since` | ISO date | no | — | Only decisions after this date |
| `limit` | number | no | 20 | Max results |

**`get_digest`** — Cross-cutting summary for a time window.
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `since` | ISO date | yes | — | Start of window |
| `until` | ISO date | no | now | End of window |

Returns per-type counts (projects, actions, decisions, questions, concepts, resources, total) plus the full entity list.

**`get_entity_context`** — Raw conversation messages around an entity.
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `entity_id` | number | yes | — | Entity ID |
| `messages_before` | number | no | 5 | Context messages before evidence |
| `messages_after` | number | no | 5 | Context messages after evidence |

Returns the entity details plus surrounding conversation from the channels where it was discussed.

### Correcting Extraction Mistakes

The bot's extraction is imperfect. Use `/search` to find entities, then `/correct` to fix them.

**Workflow:**
1. `/search deploy auth` — find the entity, note its ID (e.g., #42)
2. `/correct retype 42 action` — it was classified as a "decision" but should be an "action"
3. The bot confirms the change and logs it in the audit trail

| Subcommand | Parameters | What it does |
|------------|------------|--------------|
| `/correct retype` | `entity_id`, `new_type` | Change entity type (project, action, question, decision, concept, resource) |
| `/correct retitle` | `entity_id`, `new_title` | Fix a bad or vague title |
| `/correct resolve` | `entity_id` | Mark a question or action as resolved |
| `/correct delete` | `entity_id` | Soft-delete a bad extraction (hidden from all queries, not permanently removed) |
| `/correct merge` | `entity_id`, `into_entity_id` | Merge a duplicate into another entity. Evidence links transfer, mention counts combine, source is soft-deleted. |

All corrections are recorded in an audit log (who corrected what, when, before/after values).

---

## Entity Types

| Type | What the bot looks for | Example |
|------|----------------------|---------|
| `project` | Named initiative, product, feature, workstream | "the auth migration", "v2 redesign" |
| `action` | Commitment or assignment — someone said they'd do something | "I'll handle the Redis config", "@alice can you review the PR" |
| `question` | A question asked, tracked until answered | "Should we use Redis or Memcached?" |
| `decision` | Explicit agreement reached | "Let's go with PostgreSQL" |
| `concept` | Technical idea discussed substantively | "Event sourcing pattern for audit logs" |
| `resource` | URL, tool, library, or reference shared | "Check out https://example.com/docs" |

Entities have:
- **Status**: open, resolved, closed, or stale (auto-set after 14 days of no mentions)
- **Confidence**: 0.0–1.0 (entities below 0.3 are filtered out)
- **Mentions**: how many times the entity has been referenced across extraction cycles
- **Metadata**: assignee, deadline, tags, URLs (where identified)

---

## Architecture

```
Discord Gateway ──WSS──▶ Bot (Node.js / discord.js) ──INSERT──▶ PostgreSQL
                              │                                      ▲
                              ├── Slash Commands ◀── Discord Users    │
                              │                                      │
                         Extraction Worker (cron) ──read messages─────┘
                              │                         │
                              ▼                         │
                         Gemini Flash 3                 │
                              │                         │
                              └──upsert entities────────┘
                                                        │
                         MCP Server (:3100) ──query──────┘
                              │
                         Cloudflare Tunnel
                              │
                         Coding Agents (Claude Code, Cursor, etc.)
```

### Extraction Pipeline

Every N minutes (default 60), per guild:

1. **Window calculation** — Find the last `extraction_runs.window_end` for this guild. New window: `[last_end, now)`. First run: starts from the earliest message.
2. **Message fetch** — Query all non-deleted messages in the window.
3. **Chunking** — Split into batches of ~75 messages. Thread messages (same `thread_id`) are kept together in the same chunk. Token budget: ~100K per chunk.
4. **Extraction** — Send each chunk to Gemini Flash with a structured prompt. JSON mode enforced. Response validated against expected schema. Up to 2 retries on malformed responses.
5. **Merging** — Each extracted entity is matched against existing entities by type + title similarity (threshold: 0.4). Matches update; misses insert. Evidence links connect entities to source messages.
6. **Logging** — Token counts and USD cost recorded in `extraction_runs`.
7. **Staleness** — Daily check marks open entities with `last_seen > 14 days` as stale.

**On LLM failure:** The cycle is skipped and retried next interval. The window is not advanced, so no messages are lost.

### Entity Merging

When extraction produces an entity that might already exist:

1. Search existing entities by `guild_id` + `type` + trigram similarity on `title`
2. If best match score >= 0.4: update existing (bump `mentions`, update `last_seen`, merge metadata tags, update status if changed with confidence > 0.5)
3. If no match: insert new entity
4. Within the same batch, duplicates are merged locally before hitting the database

### Database Schema

6 tables created by migrations in `src/db/migrations/`:

| Table | Purpose |
|-------|---------|
| `messages` | Raw Discord messages (snowflake ID, content, author, channel, thread, timestamps, soft-delete) |
| `entities` | Extracted knowledge (type, title, body, status, confidence, mentions, metadata, soft-delete) |
| `entity_evidence` | Links entities to the messages that evidence them |
| `extraction_runs` | Tracks each extraction cycle (window, message count, model, token usage, cost) |
| `entity_corrections` | Audit log of user corrections (operation, before/after, user ID, timestamp) |
| `guild_config` | Per-guild settings (watched channels, extraction interval, timezone, prompt overrides) |

Key indexes: full-text search on entity title+body, trigram similarity on title, channel+time on messages.

---

## Maintenance

### Monitoring

**Structured JSON logs** — All services output JSON to stdout. Fields: `timestamp`, `level`, `service`, `message`, plus contextual data.

```bash
# Follow bot logs
docker compose logs -f bot

# Follow extraction logs (look for "Extraction complete" entries)
docker compose logs -f bot | grep extraction

# Check service health
docker compose ps
curl http://localhost:3100/health
```

**Bot `/status` command** — Shows uptime, message count, and entity count at a glance.

### Backup and Restore

**Automated backup:**
```bash
# Manual run
DATABASE_URL=postgres://secretary:${PG_PASSWORD}@localhost:5432/secretary \
  BACKUP_DIR=./backups \
  ./scripts/backup.sh

# Daily cron (add to crontab -e)
0 3 * * * cd /path/to/smithers && DATABASE_URL=postgres://secretary:${PG_PASSWORD}@localhost:5432/secretary BACKUP_DIR=./backups ./scripts/backup.sh >> /var/log/secretary-backup.log 2>&1
```

Output: `backups/secretary_YYYYMMDD_HHMMSS.sql.gz`. Old backups auto-deleted after 7 days (configurable via `BACKUP_RETENTION_DAYS`).

**Restore from backup:**
```bash
docker compose stop bot mcp
gunzip < backups/secretary_20260320_030000.sql.gz | \
  docker compose exec -T postgres psql -U secretary secretary
docker compose start bot mcp
```

### Resetting State

**Full reset** (delete everything, start fresh):
```bash
docker compose stop bot mcp

docker compose exec -T postgres psql -U secretary secretary -c "
  DROP TABLE IF EXISTS entity_corrections CASCADE;
  DROP TABLE IF EXISTS entity_evidence CASCADE;
  DROP TABLE IF EXISTS entities CASCADE;
  DROP TABLE IF EXISTS extraction_runs CASCADE;
  DROP TABLE IF EXISTS guild_config CASCADE;
  DROP TABLE IF EXISTS messages CASCADE;
  DROP TABLE IF EXISTS schema_migrations CASCADE;
"

docker compose start bot mcp
# Bot will re-run migrations on startup and backfill recent messages
```

**Reset entities only** (keep messages, re-extract):
```bash
docker compose stop bot mcp

docker compose exec -T postgres psql -U secretary secretary -c "
  TRUNCATE entity_corrections, entity_evidence, entities, extraction_runs CASCADE;
"

docker compose start bot mcp
# Extraction scheduler will detect no prior runs and process from earliest message
```

**Reset corrections only** (keep entities, clear audit log):
```bash
docker compose exec -T postgres psql -U secretary secretary -c "
  TRUNCATE entity_corrections;
"
```

### Re-extracting from History

If you improve the extraction prompt and want to re-process historical messages:

1. Truncate extraction artifacts (entities, evidence, runs, corrections) as shown above
2. Restart the bot — the scheduler will detect no prior `extraction_runs` and start from the earliest message in the `messages` table
3. All historical messages will be re-processed through the updated pipeline

The `messages` table is never modified by extraction, so this is always safe.

### Cost Tracking

Every extraction run logs token usage and cost:

```sql
-- Total cost in the last 30 days
SELECT SUM(cost_usd) AS total_cost,
       SUM(tokens_in) AS total_input_tokens,
       SUM(tokens_out) AS total_output_tokens,
       COUNT(*) AS total_runs
FROM extraction_runs
WHERE created_at >= NOW() - INTERVAL '30 days';

-- Cost per day
SELECT DATE(created_at) AS day,
       SUM(cost_usd) AS daily_cost,
       SUM(message_count) AS messages_processed
FROM extraction_runs
GROUP BY DATE(created_at)
ORDER BY day DESC;
```

Pricing (Gemini Flash): $0.10/M input tokens, $0.40/M output tokens.

---

## Exporting Data

### Export entities as JSON

```bash
docker compose exec -T postgres psql -U secretary secretary -c "
  COPY (
    SELECT json_agg(row_to_json(e))
    FROM (
      SELECT id, type, title, body, status, confidence,
             first_seen, last_seen, mentions, metadata
      FROM entities
      WHERE deleted_at IS NULL
      ORDER BY last_seen DESC
    ) e
  ) TO STDOUT;
" > entities.json
```

### Export entities as CSV

```bash
docker compose exec -T postgres psql -U secretary secretary -c "
  COPY (
    SELECT id, type, title, body, status, confidence,
           first_seen, last_seen, mentions, metadata::text
    FROM entities
    WHERE deleted_at IS NULL
    ORDER BY last_seen DESC
  ) TO STDOUT WITH CSV HEADER;
" > entities.csv
```

### Export messages as CSV

```bash
docker compose exec -T postgres psql -U secretary secretary -c "
  COPY (
    SELECT id, channel_id, author_name, content, created_at
    FROM messages
    WHERE deleted_at IS NULL
    ORDER BY created_at DESC
  ) TO STDOUT WITH CSV HEADER;
" > messages.csv
```

### Export correction audit log

```bash
docker compose exec -T postgres psql -U secretary secretary -c "
  COPY (
    SELECT ec.id, ec.entity_id, e.title AS entity_title, ec.user_id,
           ec.operation, ec.before_value, ec.after_value, ec.created_at
    FROM entity_corrections ec
    JOIN entities e ON ec.entity_id = e.id
    ORDER BY ec.created_at DESC
  ) TO STDOUT WITH CSV HEADER;
" > corrections.csv
```

### Export extraction cost history

```bash
docker compose exec -T postgres psql -U secretary secretary -c "
  COPY (
    SELECT id, guild_id, window_start, window_end, message_count,
           model, tokens_in, tokens_out, cost_usd, created_at
    FROM extraction_runs
    ORDER BY created_at DESC
  ) TO STDOUT WITH CSV HEADER;
" > extraction_runs.csv
```

### Full database dump

```bash
DATABASE_URL=postgres://secretary:${PG_PASSWORD}@localhost:5432/secretary \
  BACKUP_DIR=./exports \
  ./scripts/backup.sh
# Output: exports/secretary_YYYYMMDD_HHMMSS.sql.gz
```

---

## Testing

```bash
# Run all tests (requires PostgreSQL running)
npx vitest run

# Watch mode
npx vitest

# Run a specific test file
npx vitest run tests/entities.test.ts
```

206 tests across 17 files covering:
- Configuration validation (unit)
- Database operations: messages, entities, guild config, corrections (integration)
- Extraction: chunker, prompt builder, cost calculation (unit)
- Entity merging and similarity matching (integration)
- MCP tools: all 7 query tools (integration)
- Slash commands: all handlers and formatters (unit + integration)
- E2E command pipeline via mock interaction harness (e2e)
- Deployment configuration verification (unit)

---

## Costs

| Component | Cost |
|-----------|------|
| Hetzner VPS (CX22/CX32) | €4–8/month |
| Gemini Flash (quiet server, ~200 msgs/day) | ~$0.02/day |
| Gemini Flash (active server, ~5000 msgs/day) | ~$0.45/day |
| Cloudflare Tunnel | Free |
| **Total (typical small team)** | **~€5/month** |

---

## Documentation

- [Architecture & Design](docs/baseline.md) — Full technical specification
- [Deployment Guide](docs/deployment.md) — Hetzner + Cloudflare Tunnel setup

## License

See [LICENSE](LICENSE).
