import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { config } from '../config.js';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(config.databasePath);
    db.pragma('journal_mode = WAL');
    
    // Load sqlite-vec extension
    sqliteVec.load(db);
  }
  return db;
}

export function initDatabase(): void {
  const database = getDb();

  // Create traces table
  database.exec(`
    CREATE TABLE IF NOT EXISTS traces (
      trace_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      session_seq INTEGER NOT NULL,
      timestamp_start TEXT NOT NULL,
      timestamp_end TEXT NOT NULL,
      content_raw TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      participants TEXT NOT NULL,
      channel TEXT NOT NULL,
      trace_type TEXT NOT NULL CHECK(trace_type IN ('conversation', 'decision', 'task_completion', 'error', 'handoff')),
      is_identity_trace INTEGER NOT NULL DEFAULT 0,
      encode_status TEXT NOT NULL DEFAULT 'pending' CHECK(encode_status IN ('pending', 'encoded', 'skipped')),
      created_at TEXT NOT NULL
    );
  `);

  // Create encodes table
  database.exec(`
    CREATE TABLE IF NOT EXISTS encodes (
      encode_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      source_trace_ids TEXT NOT NULL,
      session_id TEXT NOT NULL,
      timestamp_encoded TEXT NOT NULL,
      semantic_summary TEXT NOT NULL,
      semantic_embedding BLOB NOT NULL,
      embedding_model TEXT NOT NULL,
      emotional_valence REAL NOT NULL,
      emotional_tags TEXT,
      importance_score REAL NOT NULL,
      importance_reason TEXT,
      topics TEXT NOT NULL,
      entities TEXT,
      compression_ratio REAL NOT NULL,
      consolidation_status TEXT NOT NULL DEFAULT 'pending' CHECK(consolidation_status IN ('pending', 'consolidated', 'pruned')),
      is_shared INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);

  // Create virtual table for vector search using sqlite-vec
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_encodes USING vec0(
      encode_id TEXT PRIMARY KEY,
      embedding FLOAT[1536]
    );
  `);

  // Create indexes
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_traces_agent_session ON traces(agent_id, session_id);
    CREATE INDEX IF NOT EXISTS idx_traces_encode_status ON traces(encode_status) WHERE encode_status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_encodes_consolidation ON encodes(consolidation_status) WHERE consolidation_status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_encodes_agent ON encodes(agent_id);
    CREATE INDEX IF NOT EXISTS idx_encodes_shared ON encodes(is_shared) WHERE is_shared = 1;
  `);

  console.log('Database initialized at:', config.databasePath);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
