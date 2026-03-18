# Discord Secretary — Architecture

## Overview

An always-on Discord bot that monitors channel conversations, builds a cumulative knowledge base, and exposes structured insights (projects, actions, decisions, open questions, knowledge fragments) to coding agents via MCP.

## Stack

| Layer | Tech | Rationale |
|---|---|---|
| Edge / HTTPS / DNS | Cloudflare | Proxy, TLS termination, rate limiting for MCP gateway |
| Compute | Hetzner VPS (CX22 or CX32) | €4-8/mo, persistent process for Discord WebSocket |
| Database | PostgreSQL on Hetzner | Single instance, co-located with bot process |
| LLM | Gemini Flash 3 | Cheap bulk extraction, good structured output, ~$0.10/M input tokens |
| MCP Gateway | Cloudflare Workers (or co-located on Hetzner) | Exposes knowledge to coding agents |
| Bot runtime | Node.js + discord.js v14 | Mature, well-documented, handles Gateway reconnection |

## Infrastructure Layout

```mermaid
graph TD
    subgraph Discord
        DG[Discord Gateway<br/>WSS]
    end

    subgraph Hetzner VPS
        BOT[Discord Bot<br/>Node.js / discord.js]
        PG[(PostgreSQL<br/>messages · entities<br/>extractions)]
        EX[Extraction Worker<br/>cron / queue]
        MCP[MCP Server<br/>HTTP/SSE :3100]
    end

    subgraph External APIs
        GEMINI[Gemini Flash 3]
    end

    subgraph Cloudflare
        TUNNEL[CF Tunnel / Proxy<br/>secretary.yourdomain.com/mcp]
    end

    subgraph Consumers["Coding Agent Hosts"]
        CC[Claude Code]
        CUR[Cursor]
        OTHER[Other MCP clients]
    end

    DG -- messageCreate --> BOT
    BOT -- INSERT --> PG
    EX -- read messages --> PG
    EX -- extract --> GEMINI
    GEMINI -- structured JSON --> EX
    EX -- upsert entities --> PG
    MCP -- query --> PG
    MCP -- :3100 --> TUNNEL
    TUNNEL --> CC
    TUNNEL --> CUR
    TUNNEL --> OTHER
```

## Data Model

### Core Tables

```mermaid
erDiagram
    messages {
        bigint id PK
        bigint channel_id
        bigint guild_id
        bigint author_id
        text content
        timestamptz created_at
        bigint reply_to_id
        bigint thread_id
    }

    extraction_runs {
        serial id PK
        bigint guild_id
        bigint channel_id
        timestamptz window_start
        timestamptz window_end
        int message_count
        text model
    }

    entities {
        serial id PK
        bigint guild_id
        text type
        text title
        text body
        text status
        real confidence
        timestamptz first_seen
        timestamptz last_seen
        int mentions
        jsonb metadata
    }

    entity_evidence {
        int entity_id FK
        bigint message_id FK
        int extraction_id FK
        real relevance
    }

    guild_config {
        bigint guild_id PK
        bigint[] watched_channels
        int extraction_interval_mins
        jsonb prompt_overrides
    }

    messages ||--o{ entity_evidence : "evidences"
    entities ||--o{ entity_evidence : "supported by"
    extraction_runs ||--o{ entity_evidence : "produced in"
    guild_config ||--o{ messages : "configures"
```

```sql
-- Raw message ingestion
CREATE TABLE messages (
    id              BIGINT PRIMARY KEY,         -- Discord message ID (snowflake)
    channel_id      BIGINT NOT NULL,
    guild_id        BIGINT NOT NULL,
    author_id       BIGINT NOT NULL,
    author_name     TEXT NOT NULL,
    content         TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL,
    ingested_at     TIMESTAMPTZ DEFAULT now(),
    has_attachments BOOLEAN DEFAULT false,
    reply_to_id     BIGINT,                     -- thread/reply context
    thread_id       BIGINT
);

CREATE INDEX idx_messages_channel_time ON messages (channel_id, created_at);
CREATE INDEX idx_messages_guild_time ON messages (guild_id, created_at);

-- Extraction batches — tracks what's been processed
CREATE TABLE extraction_runs (
    id              SERIAL PRIMARY KEY,
    guild_id        BIGINT NOT NULL,
    channel_id      BIGINT,                     -- NULL = cross-channel
    window_start    TIMESTAMPTZ NOT NULL,
    window_end      TIMESTAMPTZ NOT NULL,
    message_count   INT NOT NULL,
    model           TEXT NOT NULL,               -- e.g. 'gemini-2.5-flash'
    tokens_in       INT,
    tokens_out      INT,
    cost_usd        NUMERIC(8,6),
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- Extracted entities — the cumulative knowledge base
CREATE TABLE entities (
    id              SERIAL PRIMARY KEY,
    guild_id        BIGINT NOT NULL,
    type            TEXT NOT NULL,               -- project | action | question | decision | person | concept | resource
    title           TEXT NOT NULL,
    body            TEXT,                        -- longer description / context
    status          TEXT DEFAULT 'open',         -- open | closed | stale | resolved
    confidence      REAL DEFAULT 1.0,            -- LLM confidence score
    first_seen      TIMESTAMPTZ NOT NULL,
    last_seen       TIMESTAMPTZ NOT NULL,
    last_updated    TIMESTAMPTZ DEFAULT now(),
    mentions        INT DEFAULT 1,               -- how many times referenced
    metadata        JSONB DEFAULT '{}'           -- flexible: assignee, deadline, tags, etc.
);

CREATE INDEX idx_entities_type_status ON entities (guild_id, type, status);
CREATE INDEX idx_entities_search ON entities USING gin(to_tsvector('english', title || ' ' || coalesce(body, '')));

-- Links entities to the messages that evidence them
CREATE TABLE entity_evidence (
    entity_id       INT REFERENCES entities(id),
    message_id      BIGINT REFERENCES messages(id),
    extraction_id   INT REFERENCES extraction_runs(id),
    relevance       REAL DEFAULT 1.0,
    PRIMARY KEY (entity_id, message_id)
);

-- Channel/guild config
CREATE TABLE guild_config (
    guild_id        BIGINT PRIMARY KEY,
    watched_channels BIGINT[],                   -- NULL = all channels
    extraction_interval_mins INT DEFAULT 60,
    timezone        TEXT DEFAULT 'UTC',
    prompt_overrides JSONB DEFAULT '{}'           -- per-guild extraction prompt tweaks
);
```

## Discord Bot — Ingestion

Minimal. Its only job is to receive messages and write them to Postgres. No LLM calls on the hot path.

```mermaid
sequenceDiagram
    participant D as Discord Gateway
    participant B as Bot Process
    participant PG as PostgreSQL

    D->>B: messageCreate
    B->>PG: INSERT INTO messages

    D->>B: messageUpdate
    B->>PG: UPDATE messages SET content

    D->>B: messageDelete
    B->>PG: UPDATE messages SET deleted_at

    Note over B,PG: On startup: backfill last 1000 msgs/channel<br/>(ON CONFLICT DO NOTHING)
```

**Permissions needed:** `READ_MESSAGE_HISTORY`, `VIEW_CHANNEL` — nothing else. Bot never writes to Discord (unless you want digest posts later).

**Message Content Intent:** Required. Toggle in Discord Developer Portal → Bot → Privileged Gateway Intents.

## Extraction Pipeline

This is where the value lives. A scheduled worker (cron every N minutes per guild) that:

1. Queries unprocessed messages since last extraction window
2. Chunks them into context-window-sized batches (~50-100 messages per call)
3. Sends each chunk to Gemini Flash with a structured extraction prompt
4. Merges extracted entities into the cumulative knowledge base
5. Logs the extraction run for cost tracking

```mermaid
sequenceDiagram
    participant CRON as Scheduler (cron)
    participant PG as PostgreSQL
    participant CH as Chunker
    participant GEM as Gemini Flash 3
    participant MRG as Entity Merger

    CRON->>PG: Get messages since last extraction window
    PG-->>CRON: Raw messages
    CRON->>CH: Split into batches (~50-100 msgs)

    loop Each batch
        CH->>GEM: Extraction prompt + messages
        GEM-->>CH: Structured JSON (entities)
        CH->>MRG: Extracted entities
        MRG->>PG: Search existing entities (pg_trgm)
        PG-->>MRG: Similarity matches
        MRG->>PG: UPSERT entities + evidence links
    end

    CRON->>PG: Log extraction_run (tokens, cost)
```

### Extraction Prompt (straw-man)

```
You are analysing a chunk of Discord conversation. Extract structured entities.

For each entity, return JSON matching this schema:
{
  "entities": [
    {
      "type": "project" | "action" | "question" | "decision" | "concept" | "resource",
      "title": "short descriptive title",
      "body": "fuller context, 1-3 sentences",
      "status": "open" | "resolved" | "closed",
      "confidence": 0.0-1.0,
      "people": ["username1", "username2"],
      "metadata": {
        "assignee": "username or null",
        "deadline": "ISO date or null",
        "tags": ["tag1", "tag2"],
        "url": "any URL mentioned"
      },
      "evidence_message_ids": ["msg_id_1", "msg_id_2"]
    }
  ]
}

Entity type definitions:
- project: A named initiative, product, feature, or workstream being discussed
- action: Something someone said they would do, or was asked to do
- question: A question that was asked — mark resolved if answered in this chunk
- decision: An explicit decision or agreement reached
- concept: A technical concept, architecture pattern, or idea discussed substantively
- resource: A URL, tool, library, or reference shared

Rules:
- Be selective. Not every message warrants an entity.
- Merge related messages into single entities where they discuss the same thing.
- For actions, always try to identify an assignee.
- For questions, mark as resolved if the answer appears in the conversation.
- Confidence < 0.5 for anything ambiguous or speculative.
```

### Entity Merging

The hard part. When an extraction produces an entity that refers to something already in the DB:

```mermaid
flowchart TD
    A[Extracted entity from Gemini] --> B{Search existing entities<br/>by type + pg_trgm similarity}
    B -->|match score > threshold| C[Update existing entity]
    B -->|no match| D[INSERT new entity]

    C --> C1[Update last_seen]
    C --> C2[Increment mentions]
    C --> C3[Append evidence links]
    C --> C4{Status changed?}
    C4 -->|yes| C5[Update status<br/>e.g. question → resolved]
    C4 -->|no| C6[Merge metadata<br/>union tags, update assignee]

    E[Daily cron] --> F{Entity open &<br/>last_seen > 14 days?}
    F -->|yes| G[Mark as stale]
    F -->|no| H[No change]
    G --> I[Generate stale items digest]
```

For v1, text similarity matching via `pg_trgm` is fine. Embedding-based dedup is a v2 optimisation if needed.

### Cost Estimation

Gemini Flash 3 pricing (~$0.10/M input tokens, $0.40/M output tokens):

| Server activity | Messages/day | Tokens/day (est.) | Daily cost |
|---|---|---|---|
| Quiet (small team) | 200 | ~100K in, ~20K out | ~$0.02 |
| Moderate | 1,000 | ~500K in, ~100K out | ~$0.09 |
| Active community | 5,000 | ~2.5M in, ~500K out | ~$0.45 |

Essentially free for a small team server.

## MCP Gateway

Exposes the knowledge base as MCP tools that coding agents can call.

### Tools

```typescript
// Search across all entity types
tool("search_knowledge", {
  query: string,           // free text search
  type?: EntityType,       // filter by type
  status?: Status,         // filter by status
  since?: string,          // ISO date — only entities seen after this
  limit?: number           // default 20
}) → Entity[]

// Get open action items
tool("get_actions", {
  assignee?: string,       // filter by person
  status?: "open" | "stale" | "all",
  since?: string
}) → Action[]

// Get unanswered questions
tool("get_open_questions", {
  since?: string,
  channel?: string
}) → Question[]

// Get project summaries
tool("get_projects", {
  status?: "active" | "stale" | "all"
}) → Project[]

// Get recent decisions
tool("get_decisions", {
  since?: string,
  limit?: number
}) → Decision[]

// Get a digest — cross-cutting summary for a time window
tool("get_digest", {
  since: string,           // ISO date
  until?: string           // defaults to now
}) → Digest

// Get raw conversation context around a specific entity
tool("get_entity_context", {
  entity_id: number,
  messages_before?: number,  // how many surrounding messages to include
  messages_after?: number
}) → { entity: Entity, messages: Message[] }
```

### Deployment Options

**Option A: Co-located on Hetzner behind Cloudflare Tunnel**
- MCP server runs as a separate Node.js process on the same VPS
- Cloudflare Tunnel exposes it at `https://secretary.yourdomain.com/mcp`
- Zero additional infra cost
- Authentication via shared secret or Cloudflare Access

**Option B: Cloudflare Workers (proxying to Hetzner Postgres)**
- MCP server logic in a Worker
- Connects to Postgres via Hyperdrive or direct TCP (Workers supports pg)
- Better edge performance, but adds Hyperdrive complexity
- Makes sense if you want the MCP server to be multi-region

**Recommendation: Option A for v1.** Simpler, cheaper, and latency doesn't matter for agent tool calls. Cloudflare Tunnel gives you HTTPS and DDoS protection without exposing ports.

### Authentication

MCP connections need auth. Options:

1. **Bearer token** — simplest, shared secret per agent. Good enough for personal use.
2. **Cloudflare Access** — service token auth at the edge. Better for multi-user.

## Project Structure

```
discord-secretary/
├── src/
│   ├── bot/
│   │   ├── index.ts              # Discord.js client, message handlers
│   │   ├── backfill.ts           # Startup gap-fill logic
│   │   └── events.ts             # Message create/update/delete handlers
│   ├── extraction/
│   │   ├── scheduler.ts          # Cron loop: pick next extraction window
│   │   ├── chunker.ts            # Split messages into LLM-sized batches
│   │   ├── extractor.ts          # Gemini API call + response parsing
│   │   ├── merger.ts             # Entity dedup + merge logic
│   │   └── prompts.ts            # Extraction prompt templates
│   ├── mcp/
│   │   ├── server.ts             # MCP server setup (stdio or HTTP/SSE)
│   │   ├── tools.ts              # Tool definitions + handlers
│   │   └── auth.ts               # Bearer token / CF Access validation
│   ├── db/
│   │   ├── client.ts             # pg pool setup
│   │   ├── messages.ts           # Message CRUD
│   │   ├── entities.ts           # Entity CRUD + merge operations
│   │   └── migrations/           # SQL migration files
│   └── config.ts                 # Env vars, defaults
├── Dockerfile
├── docker-compose.yml            # bot + postgres + mcp server
├── package.json
└── tsconfig.json
```

## Deployment

```yaml
# docker-compose.yml (Hetzner)
services:
  postgres:
    image: postgres:17
    volumes:
      - pgdata:/var/lib/postgresql/data
    environment:
      POSTGRES_DB: secretary
      POSTGRES_USER: secretary
      POSTGRES_PASSWORD: ${PG_PASSWORD}
    restart: unless-stopped

  bot:
    build: .
    depends_on: [postgres]
    environment:
      DISCORD_TOKEN: ${DISCORD_TOKEN}
      DATABASE_URL: postgres://secretary:${PG_PASSWORD}@postgres:5432/secretary
      GEMINI_API_KEY: ${GEMINI_API_KEY}
      EXTRACTION_INTERVAL_MINS: 60
    restart: unless-stopped

  mcp:
    build: .
    command: ["node", "dist/mcp/server.js"]
    depends_on: [postgres]
    environment:
      DATABASE_URL: postgres://secretary:${PG_PASSWORD}@postgres:5432/secretary
      MCP_AUTH_TOKEN: ${MCP_AUTH_TOKEN}
      PORT: 3100
    ports:
      - "3100:3100"   # exposed via Cloudflare Tunnel
    restart: unless-stopped

  cloudflared:
    image: cloudflare/cloudflared:latest
    command: tunnel run
    environment:
      TUNNEL_TOKEN: ${CF_TUNNEL_TOKEN}
    restart: unless-stopped

volumes:
  pgdata:
```

Total Hetzner cost: ~€4-8/month for a CX22/CX32. Gemini costs negligible. Cloudflare Tunnel is free.

## Open Questions / V2 Considerations

1. **Digest delivery** — Post daily/weekly digests back to a Discord channel? Or keep it pull-only via MCP?
2. **Embedding search** — For v1, `pg_trgm` + `ts_vector` is fine. If entity count grows past ~10K, add `pgvector` for semantic search.
3. **Cross-server** — Data model supports multi-guild. MCP auth would need scoping.
4. **Conversation threading** — Discord threads are first-class. Thread messages should be grouped and extracted as coherent units rather than interleaved with main channel traffic.
5. **Retroactive re-extraction** — When you improve the extraction prompt, you'll want to re-run it over historical data. The extraction_runs table supports this — just create new runs over old windows.
6. **Human correction loop** — An MCP tool like `correct_entity(id, corrections)` that lets an agent (or human via bot command) fix misclassifications feeds back into extraction quality.
