-- Add soft-delete support to entities
ALTER TABLE entities ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Audit log for entity corrections
CREATE TABLE IF NOT EXISTS entity_corrections (
    id              SERIAL PRIMARY KEY,
    entity_id       INT NOT NULL REFERENCES entities(id),
    user_id         TEXT NOT NULL,
    operation       TEXT NOT NULL,
    before_value    TEXT,
    after_value     TEXT,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_entity_corrections_entity_id ON entity_corrections (entity_id);

-- Partial index to speed up queries that exclude deleted entities
CREATE INDEX IF NOT EXISTS idx_entities_not_deleted ON entities (guild_id, type, status) WHERE deleted_at IS NULL;
