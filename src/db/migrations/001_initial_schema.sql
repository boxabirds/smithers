-- Enable trigram similarity for entity matching
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Raw message ingestion
CREATE TABLE IF NOT EXISTS messages (
    id              BIGINT PRIMARY KEY,
    channel_id      BIGINT NOT NULL,
    guild_id        BIGINT NOT NULL,
    author_id       BIGINT NOT NULL,
    author_name     TEXT NOT NULL,
    content         TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL,
    ingested_at     TIMESTAMPTZ DEFAULT now(),
    has_attachments BOOLEAN DEFAULT false,
    reply_to_id     BIGINT,
    thread_id       BIGINT,
    deleted_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_messages_channel_time ON messages (channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_guild_time ON messages (guild_id, created_at);

-- Extraction batches
CREATE TABLE IF NOT EXISTS extraction_runs (
    id              SERIAL PRIMARY KEY,
    guild_id        BIGINT NOT NULL,
    channel_id      BIGINT,
    window_start    TIMESTAMPTZ NOT NULL,
    window_end      TIMESTAMPTZ NOT NULL,
    message_count   INT NOT NULL,
    model           TEXT NOT NULL,
    tokens_in       INT,
    tokens_out      INT,
    cost_usd        NUMERIC(8,6),
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- Extracted entities
CREATE TABLE IF NOT EXISTS entities (
    id              SERIAL PRIMARY KEY,
    guild_id        BIGINT NOT NULL,
    type            TEXT NOT NULL,
    title           TEXT NOT NULL,
    body            TEXT,
    status          TEXT DEFAULT 'open',
    confidence      REAL DEFAULT 1.0,
    first_seen      TIMESTAMPTZ NOT NULL,
    last_seen       TIMESTAMPTZ NOT NULL,
    last_updated    TIMESTAMPTZ DEFAULT now(),
    mentions        INT DEFAULT 1,
    metadata        JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_entities_type_status ON entities (guild_id, type, status);
CREATE INDEX IF NOT EXISTS idx_entities_search ON entities USING gin(to_tsvector('english', title || ' ' || coalesce(body, '')));
CREATE INDEX IF NOT EXISTS idx_entities_similarity ON entities USING gin(title gin_trgm_ops);

-- Entity evidence links
CREATE TABLE IF NOT EXISTS entity_evidence (
    entity_id       INT REFERENCES entities(id),
    message_id      BIGINT REFERENCES messages(id),
    extraction_id   INT REFERENCES extraction_runs(id),
    relevance       REAL DEFAULT 1.0,
    PRIMARY KEY (entity_id, message_id)
);

-- Guild configuration
CREATE TABLE IF NOT EXISTS guild_config (
    guild_id                BIGINT PRIMARY KEY,
    watched_channels        BIGINT[],
    extraction_interval_mins INT DEFAULT 60,
    timezone                TEXT DEFAULT 'UTC',
    prompt_overrides        JSONB DEFAULT '{}'
);
