-- Resonant Mind - Database Schema
-- Persistent cognitive infrastructure for AI systems

-- Entities (people, concepts, things known about)
CREATE TABLE entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    primary_context TEXT NOT NULL DEFAULT 'default',
    salience TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(name, primary_context)
);

-- Observations about entities
CREATE TABLE observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    salience TEXT DEFAULT 'active',
    emotion TEXT,
    weight TEXT DEFAULT 'medium',
    certainty TEXT DEFAULT 'believed',
    source TEXT DEFAULT 'conversation',
    source_date TEXT,
    context TEXT DEFAULT 'default',
    charge TEXT,
    charge_note TEXT,
    sit_count INTEGER DEFAULT 0,
    novelty_score REAL DEFAULT 1.0,
    last_surfaced_at TEXT,
    surface_count INTEGER DEFAULT 0,
    archived_at TEXT,
    added_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
);

-- Observation version history
CREATE TABLE observation_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    observation_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    weight TEXT,
    emotion TEXT,
    changed_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (observation_id) REFERENCES observations(id) ON DELETE CASCADE
);

-- Relations between entities
CREATE TABLE relations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_entity TEXT NOT NULL,
    to_entity TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    from_context TEXT DEFAULT 'default',
    to_context TEXT DEFAULT 'default',
    store_in TEXT DEFAULT 'default',
    created_at TEXT DEFAULT (datetime('now'))
);

-- Active threads (intentions across sessions)
CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    thread_type TEXT NOT NULL,
    content TEXT NOT NULL,
    context TEXT,
    priority TEXT DEFAULT 'medium',
    status TEXT DEFAULT 'active',
    source TEXT DEFAULT 'self',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT,
    resolution TEXT
);

-- Context layer (situational awareness)
CREATE TABLE context_entries (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    content TEXT NOT NULL,
    links TEXT DEFAULT '[]',
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Relational state (feelings toward people)
CREATE TABLE relational_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person TEXT NOT NULL,
    feeling TEXT NOT NULL,
    intensity TEXT NOT NULL,
    timestamp TEXT DEFAULT (datetime('now'))
);

-- Identity graph
CREATE TABLE identity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section TEXT NOT NULL,
    content TEXT NOT NULL,
    weight REAL DEFAULT 0.7,
    connections TEXT DEFAULT '[]',
    timestamp TEXT DEFAULT (datetime('now'))
);

-- Journals (episodic memory)
CREATE TABLE journals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_date TEXT,
    content TEXT NOT NULL,
    tags TEXT DEFAULT '[]',
    emotion TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Images (visual memory)
CREATE TABLE images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL,
    description TEXT NOT NULL,
    context TEXT,
    emotion TEXT,
    weight TEXT DEFAULT 'medium',
    entity_id INTEGER,
    observation_id INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (entity_id) REFERENCES entities(id),
    FOREIGN KEY (observation_id) REFERENCES observations(id)
);

-- Subconscious state (daemon processing results)
CREATE TABLE subconscious (
    id INTEGER PRIMARY KEY,
    state_type TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Daemon proposals (suggested connections from co-surfacing patterns)
CREATE TABLE daemon_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    obs_a_id INTEGER NOT NULL,
    obs_b_id INTEGER NOT NULL,
    entity_a TEXT,
    entity_b TEXT,
    co_surface_count INTEGER DEFAULT 1,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (obs_a_id) REFERENCES observations(id),
    FOREIGN KEY (obs_b_id) REFERENCES observations(id)
);

-- Tensions (productive contradictions)
CREATE TABLE tensions (
    id TEXT PRIMARY KEY,
    pole_a TEXT NOT NULL,
    pole_b TEXT NOT NULL,
    context TEXT,
    sit_count INTEGER DEFAULT 0,
    sit_notes TEXT DEFAULT '[]',
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT,
    resolution TEXT
);

-- Co-surfacing tracking (which observations appear together)
CREATE TABLE co_surfacing (
    obs_a_id INTEGER NOT NULL,
    obs_b_id INTEGER NOT NULL,
    count INTEGER DEFAULT 1,
    last_seen TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (obs_a_id, obs_b_id),
    FOREIGN KEY (obs_a_id) REFERENCES observations(id),
    FOREIGN KEY (obs_b_id) REFERENCES observations(id)
);

-- Indexes for common queries
CREATE INDEX idx_entities_context ON entities(primary_context);
CREATE INDEX idx_entities_name ON entities(name);
CREATE INDEX idx_entities_salience ON entities(salience);
CREATE INDEX idx_observations_entity ON observations(entity_id);
CREATE INDEX idx_observations_context ON observations(context);
CREATE INDEX idx_observations_charge ON observations(charge);
CREATE INDEX idx_observations_weight ON observations(weight);
CREATE INDEX idx_observations_archived ON observations(archived_at);
CREATE INDEX idx_observations_surfaced ON observations(last_surfaced_at);
CREATE INDEX idx_threads_status ON threads(status);
CREATE INDEX idx_context_scope ON context_entries(scope);
CREATE INDEX idx_relational_person ON relational_state(person);
CREATE INDEX idx_identity_section ON identity(section);
CREATE INDEX idx_journals_date ON journals(entry_date);
CREATE INDEX idx_images_entity ON images(entity_id);
CREATE INDEX idx_daemon_proposals_status ON daemon_proposals(status);
CREATE INDEX idx_tensions_status ON tensions(status);
