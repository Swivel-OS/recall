-- RECALL Access Tracking & Reinforcement Schema
-- Tracks memory access for reinforcement scoring

-- Access log table — every time a memory is recalled
CREATE TABLE IF NOT EXISTS memory_access_log (
    access_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    encode_id       TEXT NOT NULL,
    agent_id        TEXT NOT NULL,
    access_type     TEXT NOT NULL CHECK(access_type IN ('query', 'boot', 'bond_traversal', 'explicit_recall')),
    query_text      TEXT,           -- What was searched (for query access)
    relevance_score REAL,           -- How relevant was this result (0-1)
    access_ts       TEXT NOT NULL,
    context         TEXT            -- JSON: session_id, channel, etc.
);

CREATE INDEX IF NOT EXISTS idx_access_encode ON memory_access_log(encode_id);
CREATE INDEX IF NOT EXISTS idx_access_agent_ts ON memory_access_log(agent_id, access_ts);
CREATE INDEX IF NOT EXISTS idx_access_ts ON memory_access_log(access_ts);

-- Memory reinforcement state — accumulated strength from accesses
CREATE TABLE IF NOT EXISTS memory_reinforcement (
    encode_id           TEXT PRIMARY KEY,
    total_accesses      INTEGER DEFAULT 0,
    recent_accesses_7d  INTEGER DEFAULT 0,  -- Last 7 days (hot memories)
    recent_accesses_30d INTEGER DEFAULT 0,  -- Last 30 days
    reinforcement_score REAL DEFAULT 1.0,   -- Multiplier (1.0 = baseline, >1 = stronger)
    last_access_ts      TEXT,
    first_access_ts     TEXT,
    updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reinforcement_score ON memory_reinforcement(reinforcement_score DESC);

-- Consolidation log — track when consolidation runs
CREATE TABLE IF NOT EXISTS consolidation_log (
    run_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at      TEXT NOT NULL,
    completed_at    TEXT,
    memories_processed INTEGER,
    memories_reinforced INTEGER,
    memories_pruned INTEGER,
    notes           TEXT
);
