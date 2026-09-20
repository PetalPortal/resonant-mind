-- Phase 1: Access tracking for multi-factor retrieval scoring
ALTER TABLE observations ADD COLUMN access_count INTEGER DEFAULT 0;
ALTER TABLE observations ADD COLUMN last_accessed_at TEXT;
ALTER TABLE images ADD COLUMN access_count INTEGER DEFAULT 0;
ALTER TABLE images ADD COLUMN last_accessed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_observations_access ON observations(access_count);
CREATE INDEX IF NOT EXISTS idx_observations_last_accessed ON observations(last_accessed_at);

-- Phase 2: Temporal validity for fact management
ALTER TABLE observations ADD COLUMN valid_from TEXT;
ALTER TABLE observations ADD COLUMN valid_until TEXT;
ALTER TABLE observations ADD COLUMN superseded_by INTEGER REFERENCES observations(id);
ALTER TABLE observations ADD COLUMN supersedes INTEGER REFERENCES observations(id);

CREATE INDEX IF NOT EXISTS idx_observations_valid_until ON observations(valid_until);
CREATE INDEX IF NOT EXISTS idx_observations_superseded ON observations(superseded_by);

-- Phase 3: Consolidation groups and reflection journals
-- source_observation_ids is stored as a JSON array string (TEXT) — the runtime
-- adapter doesn't need to know about Postgres INTEGER[]; the code JSON.stringifies
-- the cluster before binding.
CREATE TABLE IF NOT EXISTS consolidation_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    summary TEXT NOT NULL,
    entity_id INTEGER REFERENCES entities(id),
    source_observation_ids TEXT NOT NULL,
    consolidated_observation_id INTEGER REFERENCES observations(id),
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_consolidation_entity ON consolidation_groups(entity_id);

ALTER TABLE journals ADD COLUMN journal_type TEXT DEFAULT 'entry';
CREATE INDEX IF NOT EXISTS idx_journals_type ON journals(journal_type);
