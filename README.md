# Discord Secretary

An always-on Discord bot that monitors channel conversations, builds a cumulative knowledge base, and exposes structured insights (projects, actions, decisions, open questions, knowledge fragments) to coding agents via MCP.

## Stack

| Layer | Tech | Rationale |
|---|---|---|
| Edge / HTTPS / DNS | Cloudflare | Proxy, TLS termination, rate limiting for MCP gateway |
| Compute | Hetzner VPS (CX22 or CX32) | €4-8/mo, persistent process for Discord WebSocket |
| Database | PostgreSQL on Hetzner | Single instance, co-located with bot process |
| LLM | Gemini Flash 3 | Cheap bulk extraction, good structured output, ~$0.10/M input tokens |
| MCP Gateway | Co-located on Hetzner | Exposes knowledge to coding agents via Cloudflare Tunnel |
| Bot runtime | Node.js + discord.js v14 | Mature, well-documented, handles Gateway reconnection |

## Architecture

```
Discord Gateway ──WSS──▶ Bot (Node.js / discord.js) ──INSERT──▶ PostgreSQL
                                                                    ▲
                         Extraction Worker (cron) ──read messages────┘
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
                         Consumers (Claude Code, Cursor, Ceetrix Agents)
```

## How It Works

1. **Ingestion** — The bot connects to Discord via WebSocket and writes every message to PostgreSQL. No LLM calls on the hot path.
2. **Extraction** — A scheduled worker (configurable interval, default 60 min) reads unprocessed messages, chunks them, and sends each batch to Gemini Flash for structured entity extraction.
3. **Entity Merging** — Extracted entities are matched against existing ones using `pg_trgm` similarity. Matches update existing entities; new ones are inserted.
4. **MCP Gateway** — An HTTP/SSE server exposes the knowledge base as MCP tools for coding agents to query.

## Entity Types

| Type | Description |
|---|---|
| `project` | Named initiative, product, feature, or workstream |
| `action` | Something someone committed to doing |
| `question` | A question asked — tracked until resolved |
| `decision` | An explicit decision or agreement |
| `concept` | Technical concept or architecture pattern discussed |
| `resource` | URL, tool, library, or reference shared |

## MCP Tools

- `search_knowledge` — Free text search across all entity types
- `get_actions` — Open action items, filterable by assignee
- `get_open_questions` — Unanswered questions
- `get_projects` — Project summaries by status
- `get_decisions` — Recent decisions
- `get_digest` — Cross-cutting summary for a time window
- `get_entity_context` — Raw conversation context around a specific entity

## Development

```bash
cp .env.example .env  # fill in DISCORD_TOKEN, GEMINI_API_KEY, PG_PASSWORD, etc.
docker compose up -d
```

## Deployment

Runs on a single Hetzner VPS behind Cloudflare Tunnel. See `docker-compose.yml` for the full service definition.

**Estimated costs:**
- Hetzner CX22/CX32: €4-8/mo
- Gemini Flash 3: ~$0.02-0.45/day depending on server activity
- Cloudflare Tunnel: free

## Documentation

- [Architecture & Design](docs/baseline.md) — Full technical specification

## License

See [LICENSE](LICENSE).
