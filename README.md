# Smithers

An always-on Discord bot that monitors channel conversations, builds a cumulative knowledge base with full server context, and exposes structured insights to both Discord users (via slash commands) and coding agents (via MCP).

---

## Table of Contents

- [How It Works](#how-it-works)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [Entity Types](#entity-types)
- [Architecture](#architecture)
- [Maintenance](#maintenance)
- [Exporting Data](#exporting-data)
- [Testing](#testing)
- [Costs](#costs)

---

## How It Works

1. **Ingestion** — The bot connects to Discord via WebSocket and writes every message to PostgreSQL. Personal data (emails, phone numbers, credit cards, IP addresses) is automatically redacted before storage using `@arcjet/redact`. On startup, it backfills the last 1,000 messages per channel to cover any gaps from downtime.

2. **Extraction** — When a conversation goes quiet for 5 minutes, the bot uploads all existing entities and new messages as JSON files to the Gemini File API, then makes a single LLM call with full server context. This means Gemini can see every entity ever extracted and connect new messages to existing items — e.g. recognising "ok done with the Redis config" as resolving a previously-extracted action.

3. **Entity Merging** — Extracted entities are matched against existing ones using trigram text similarity (`pg_trgm`) or direct ID references from the LLM. Matches update existing entities; new entities are inserted. Entities not seen in 14+ days are automatically marked stale.

4. **Querying** — Discord users query the knowledge base via slash commands (`/actions`, `/questions`, `/about`, etc.). Coding agents query via MCP tools. During extraction, slash commands block silently (Discord shows "thinking...") and return fresh results once extraction completes.

5. **Correction** — Users fix extraction mistakes via `/correct` commands. Corrections are audit-logged.

---

## Installation

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- A Discord account with permission to create bots
- A [Google AI Studio](https://ai.google.dev/) account for the Gemini API key
- `hcloud` CLI for Hetzner provisioning (optional — for production deployment)

### Discord Bot Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications) and create a new application.
2. Navigate to **Bot** and click **Reset Token**. Save the token for `DISCORD_TOKEN`.
3. Under **Privileged Gateway Intents**, enable **Message Content Intent**.
4. Navigate to **OAuth2 > URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: `Read Message History`, `View Channels`, `Send Messages`, `Use Slash Commands`
5. Copy the generated URL and open it to invite the bot to your server.

### Local Development

```bash
git clone git@github.com:boxabirds/smithers.git
cd smithers

cp .env.example .env
# Fill in DISCORD_TOKEN, GEMINI_API_KEY, MCP_AUTH_TOKEN, PG_PASSWORD

docker compose up postgres -d
npm install
npx tsx src/index.ts
```

### Production Deployment (IaC)

Provisioning is fully scripted — no clickops required after the initial token creation.

**One-time setup:**
1. Create a Hetzner API token (Cloud Console > project > Security > API Tokens)
2. Install and authenticate: `brew install hcloud && hcloud context create smithers`
3. Get your Discord bot token, Gemini API key (see above)
4. Generate secrets: `openssl rand -hex 32` (run twice — one for `MCP_AUTH_TOKEN`, one for `PG_PASSWORD`)

**Provision and deploy:**
```bash
cp .env.production.example .env.production
# Fill in your 4 required tokens

./scripts/provision.sh    # Creates VPS, firewall, SSH key, deploys
```

This creates an ARM server (Hetzner cax11, €3.29/mo), installs Docker, syncs the project, writes `.env`, builds and starts all containers.

**Subsequent deploys** (code changes):
```bash
./scripts/deploy.sh
```

**Tear down:**
```bash
./scripts/teardown.sh     # Destroys server + firewall (with confirmation)
```

**Cloudflare Tunnel** (optional, for external MCP access):
```bash
# Add CF_TUNNEL_TOKEN to .env.production, then:
./scripts/deploy.sh       # Automatically starts cloudflared container
```

---

## Configuration

All configuration is via environment variables. See [`.env.example`](.env.example) for the full list.

### Required

| Variable | Description |
|----------|-------------|
| `DISCORD_TOKEN` | Bot token from Discord Developer Portal |
| `DATABASE_URL` | PostgreSQL connection string |
| `GEMINI_API_KEY` | API key from Google AI Studio |
| `MCP_AUTH_TOKEN` | Shared secret for authenticating MCP tool calls |
| `PG_PASSWORD` | PostgreSQL password (used by Docker Compose) |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_MODEL_ID` | `gemini-3-flash-latest` | Gemini model to use for extraction |
| `EXTRACTION_INTERVAL_MINS` | `60` | Maximum minutes between extractions (ceiling for event-driven trigger) |
| `DB_POOL_MIN` | `2` | Minimum database connections |
| `DB_POOL_MAX` | `10` | Maximum database connections |
| `MCP_PORT` | `3100` | Port for the MCP server |
| `LOG_LEVEL` | `info` | Logging level: `error`, `warn`, `info`, `debug` |
| `CF_TUNNEL_TOKEN` | — | Cloudflare Tunnel token (production only) |

---

## Usage

### Discord Slash Commands

| Command | Parameters | What it does |
|---------|------------|--------------|
| `/about` | — | What the bot does, what entity types it tracks |
| `/help` | — | List all available commands |
| `/actions` | `assignee` (optional) | Open action items, optionally filtered by person |
| `/questions` | — | Unanswered questions |
| `/digest` | `days` (optional, default 7) | Activity summary across all types |
| `/projects` | — | Active projects |
| `/decisions` | `days` (optional, default 7) | Recent decisions |
| `/status` | — | Bot health: uptime, messages captured, entities extracted |
| `/search` | `query` (required) | Free-text search across all entity types |
| `/correct` | see below | Fix extraction mistakes |

Each entity is shown with its title (bold) and body text for context. Commands are registered per-guild for instant availability.

### Correcting Extraction Mistakes

Use `/search` to find entities, then `/correct` to fix them:

| Subcommand | Parameters | What it does |
|------------|------------|--------------|
| `/correct retype` | `entity_id`, `new_type` | Change entity type |
| `/correct retitle` | `entity_id`, `new_title` | Fix a bad title |
| `/correct resolve` | `entity_id` | Mark as resolved |
| `/correct delete` | `entity_id` | Soft-delete a bad extraction |
| `/correct merge` | `entity_id`, `into_entity_id` | Merge duplicate into another entity |

All corrections are recorded in an audit log.

### MCP Tools for Coding Agents

The MCP server runs on port 3100 and exposes 7 tools. Connect from Claude Code, Cursor, or any MCP-compatible client.

**Authentication:** `Authorization: Bearer <MCP_AUTH_TOKEN>`

**Health check:** `GET /health`

**Tools:** `search_knowledge`, `get_actions`, `get_open_questions`, `get_projects`, `get_decisions`, `get_digest`, `get_entity_context`

See tool parameter details via MCP tool discovery.

---

## Entity Types

| Type | What the bot looks for | Example |
|------|----------------------|---------|
| `project` | Named initiative, product, feature, workstream | "the auth migration", "v2 redesign" |
| `action` | Commitment or assignment | "I'll handle the Redis config" |
| `question` | A question asked, tracked until answered | "Should we use Redis or Memcached?" |
| `decision` | Explicit agreement reached | "Let's go with PostgreSQL" |
| `concept` | Technical idea discussed substantively | "Event sourcing pattern for audit logs" |
| `resource` | URL, tool, library, or reference shared | "Check out https://example.com/docs" |

Entities have status (open/resolved/closed/stale), confidence (0.0-1.0), mention count, and metadata (assignee, deadline, tags, URLs).

---

## Architecture

```
Discord Gateway ──WSS──> Bot (Node.js / discord.js)
                           │
                           ├── Capture message
                           │     └── Redact PII (@arcjet/redact)
                           │     └── Store in PostgreSQL
                           │     └── Notify scheduler (update lastMessageTime)
                           │
                           ├── Slash Commands <── Discord Users
                           │     └── Await extraction lock (if running)
                           │     └── Query DB, return embed
                           │
                           └── Event-driven Extraction
                                 └── Triggered after 5 min quiet (or max ceiling)
                                 └── Acquire per-guild lock
                                 └── Upload all entities + new messages to Gemini File API
                                 └── Single generateContent call with full server context
                                 └── Merge results (new entities + updates by ID)
                                 └── Release lock

MCP Server (:3100) ── Query PostgreSQL ── Cloudflare Tunnel ── Coding Agents
```

### Extraction Pipeline

When a conversation goes quiet (no messages for 5 minutes), per guild:

1. **Acquire lock** — Per-guild semaphore blocks slash commands during extraction
2. **Entity context** — Fetch all existing entities from PostgreSQL
3. **Message window** — Fetch new messages since last extraction
4. **File upload** — Upload entities and messages as JSON to Gemini File API (free storage, 48h auto-delete)
5. **Extraction** — Single `generateContent` call with file references + prompt. Gemini can emit new entities or update existing ones by ID (`resolves_existing_id`)
6. **Merging** — Updates by ID bypass similarity search. New entities go through trigram matching as before.
7. **Release lock** — Slash commands unblocked, return fresh results
8. **Cost logging** — Token counts and estimated cost recorded in `extraction_runs`

**Fallback:** If no quiet period occurs within `EXTRACTION_INTERVAL_MINS`, extraction is forced.

**On LLM failure:** The run is skipped and retried next trigger. The window is not advanced.

### PII Redaction

All message content is redacted before storage using `@arcjet/redact` (WASM-based):
- Email addresses
- Phone numbers (including international formats)
- Credit card numbers
- IP addresses (IPv4 and IPv6)

Discord usernames are preserved for entity attribution. If redaction fails, the message is stored with original content and a warning is logged.

### Database Schema

6 tables created by migrations in `src/db/migrations/`:

| Table | Purpose |
|-------|---------|
| `messages` | Raw Discord messages (redacted content, author, channel, thread, timestamps, soft-delete) |
| `entities` | Extracted knowledge (type, title, body, status, confidence, mentions, metadata, soft-delete) |
| `entity_evidence` | Links entities to the messages that evidence them |
| `extraction_runs` | Tracks each extraction run (window, message count, model, token usage, cost) |
| `entity_corrections` | Audit log of user corrections |
| `guild_config` | Per-guild settings |

---

## Maintenance

### Monitoring

```bash
docker compose logs -f bot              # Follow bot logs
docker compose logs -f bot | grep extraction  # Extraction events only
docker compose ps                       # Service health
```

### Backup and Restore

```bash
# Manual backup
DATABASE_URL=postgres://secretary:${PG_PASSWORD}@localhost:5432/secretary \
  BACKUP_DIR=./backups \
  ./scripts/backup.sh

# Restore
docker compose stop bot mcp
gunzip < backups/secretary_YYYYMMDD_HHMMSS.sql.gz | \
  docker compose exec -T postgres psql -U secretary secretary
docker compose start bot mcp
```

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
```

Current pricing constants: $0.30/M input tokens, $2.50/M output tokens (Gemini Flash).

---

## Exporting Data

```bash
# Entities as JSON
docker compose exec -T postgres psql -U secretary secretary -c "
  COPY (SELECT json_agg(row_to_json(e)) FROM (
    SELECT id, type, title, body, status, confidence, first_seen, last_seen, mentions, metadata
    FROM entities WHERE deleted_at IS NULL ORDER BY last_seen DESC
  ) e) TO STDOUT;" > entities.json

# Entities as CSV
docker compose exec -T postgres psql -U secretary secretary -c "
  COPY (SELECT id, type, title, body, status, confidence, first_seen, last_seen, mentions, metadata::text
    FROM entities WHERE deleted_at IS NULL ORDER BY last_seen DESC
  ) TO STDOUT WITH CSV HEADER;" > entities.csv
```

---

## Testing

```bash
npx vitest run          # All tests (requires PostgreSQL running)
npx vitest              # Watch mode
```

263 tests across 20 files covering configuration, database operations, extraction pipeline, entity merging, PII redaction, MCP tools, slash commands, and e2e command pipeline.

---

## Costs

| Component | Cost |
|-----------|------|
| Hetzner VPS (cax11 ARM) | €3.29/month |
| Gemini Flash (quiet server) | ~$0.01/run |
| Gemini Flash (active server) | ~$0.02/run |
| Gemini File API storage | Free |
| Cloudflare Tunnel | Free |

Runs are event-driven (triggered by conversation silence), not fixed-interval. A typical small team triggers 10-20 runs/day during business hours.
