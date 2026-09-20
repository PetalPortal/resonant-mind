-- Graph health, dormancy tracking, and Living Surface schema fixes
--
-- Two semantic concerns are made first-class here, plus three latent
-- schema-vs-code mismatches that have been silently broken since the v3 series.
--
-- Concept rename
-- --------------
-- The word "orphan" had been overloaded to mean two different things:
--   1. Dormancy  — observations that haven't surfaced in 30+ days
--   2. Isolation — entities with no relations (graph disconnection)
-- This migration introduces explicit tracking for both.
--
-- Schema fixes for previously latent code/schema drift
-- ----------------------------------------------------
-- The code references several tables and columns that earlier migrations
-- never created. Every affected code path failed silently inside try/catch:
--   * `orphan_observations` was never created — replaced here by `dormant_observations`
--   * `daemon_proposals` schema was completely incompatible with the code
--     (proposal_type, from_obs_id, to_obs_id, from_entity_id, to_entity_id,
--      reason, confidence, proposed_at, resolved_at — none existed)
--   * `co_surfacing` was missing autoincrement id, plus columns
--     co_count, last_co_surfaced, relation_proposed, relation_created
--     (the old columns were named count, last_seen)
--   * observations needed resolved_at, resolution_note, linked_observation_id
--     for `mind_resolve` to function

-- ============ Dormancy tracking (replaces never-shipped orphan_observations) ============
CREATE TABLE dormant_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    observation_id INTEGER NOT NULL UNIQUE,
    first_marked TEXT DEFAULT (datetime('now')),
    rescue_attempts INTEGER DEFAULT 0,
    last_rescue_attempt TEXT,
    FOREIGN KEY (observation_id) REFERENCES observations(id) ON DELETE CASCADE
);

CREATE INDEX idx_dormant_observation ON dormant_observations(observation_id);

-- ============ Graph isolation flag ============
-- Entities can be marked "intentionally standalone" via `mind_isolated ignore`
-- so they stop appearing in isolation reports.
ALTER TABLE entities ADD COLUMN intentionally_isolated INTEGER DEFAULT 0;
CREATE INDEX idx_entities_intentionally_isolated ON entities(intentionally_isolated);

-- ============ Resolution columns on observations ============
-- `mind_resolve` metabolizes an observation and records resolution context.
-- These three columns were missing from every prior migration.
ALTER TABLE observations ADD COLUMN resolved_at TEXT;
ALTER TABLE observations ADD COLUMN resolution_note TEXT;
ALTER TABLE observations ADD COLUMN linked_observation_id INTEGER REFERENCES observations(id);

CREATE INDEX idx_observations_resolved ON observations(resolved_at);

-- ============ Surface-tracking columns on images ============
-- Image surfacing was implemented in code but the columns never existed in any
-- migration. updateSurfaceTracking and handleMindSurface both reference them.
ALTER TABLE images ADD COLUMN novelty_score REAL DEFAULT 1.0;
ALTER TABLE images ADD COLUMN last_surfaced_at TEXT;
ALTER TABLE images ADD COLUMN surface_count INTEGER DEFAULT 0;
ALTER TABLE images ADD COLUMN archived_at TEXT;

-- ============ daemon_proposals — schema rewrite ============
-- The original table used (obs_a_id, obs_b_id, entity_a TEXT, entity_b TEXT,
-- co_surface_count, status, created_at). The code uses an entirely different
-- shape supporting three proposal kinds: 'resonance' (same-entity), 'relation'
-- (cross-entity), and 'proximity' (entity pairs with no observation link).
--
-- Since the original schema couldn't accept any of the code's writes, there's
-- no data to migrate — every prior INSERT failed inside try/catch. Safe to drop.
DROP TABLE IF EXISTS daemon_proposals;

CREATE TABLE daemon_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_type TEXT NOT NULL,          -- 'resonance' | 'relation' | 'proximity'
    from_obs_id INTEGER,                  -- nullable for 'proximity' type
    to_obs_id INTEGER,                    -- nullable for 'proximity' type
    from_entity_id INTEGER NOT NULL,
    to_entity_id INTEGER NOT NULL,
    reason TEXT,
    confidence REAL DEFAULT 0.5,
    status TEXT DEFAULT 'pending',        -- 'pending' | 'accepted' | 'rejected'
    proposed_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT,
    FOREIGN KEY (from_obs_id) REFERENCES observations(id) ON DELETE CASCADE,
    FOREIGN KEY (to_obs_id) REFERENCES observations(id) ON DELETE CASCADE,
    FOREIGN KEY (from_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
    FOREIGN KEY (to_entity_id) REFERENCES entities(id) ON DELETE CASCADE
);

CREATE INDEX idx_daemon_proposals_status ON daemon_proposals(status);
CREATE INDEX idx_daemon_proposals_type ON daemon_proposals(proposal_type);

-- ============ co_surfacing — schema rewrite ============
-- Original: (obs_a_id, obs_b_id, count, last_seen) with composite PK.
-- Code uses: autoincrement id, co_count, last_co_surfaced, relation_proposed,
-- relation_created, UNIQUE(obs_a_id, obs_b_id). Same data-loss reasoning: every
-- prior write failed because of column-name mismatch.
DROP TABLE IF EXISTS co_surfacing;

CREATE TABLE co_surfacing (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    obs_a_id INTEGER NOT NULL,
    obs_b_id INTEGER NOT NULL,
    co_count INTEGER DEFAULT 1,
    last_co_surfaced TEXT DEFAULT (datetime('now')),
    relation_proposed INTEGER DEFAULT 0,
    relation_created INTEGER DEFAULT 0,
    UNIQUE (obs_a_id, obs_b_id),
    FOREIGN KEY (obs_a_id) REFERENCES observations(id) ON DELETE CASCADE,
    FOREIGN KEY (obs_b_id) REFERENCES observations(id) ON DELETE CASCADE
);

CREATE INDEX idx_co_surfacing_pair ON co_surfacing(obs_a_id, obs_b_id);
CREATE INDEX idx_co_surfacing_count ON co_surfacing(co_count);
