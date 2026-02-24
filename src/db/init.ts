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
      significance INTEGER DEFAULT 5 CHECK(significance >= 1 AND significance <= 10),
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
      memory_type TEXT DEFAULT 'episodic' CHECK(memory_type IN ('episodic', 'semantic', 'procedural', 'self_model')),
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

  // Create bonds table
  database.exec(`
    CREATE TABLE IF NOT EXISTS bonds (
      bond_id TEXT PRIMARY KEY,
      encode_id_a TEXT NOT NULL,
      encode_id_b TEXT NOT NULL,
      bond_type TEXT NOT NULL CHECK(bond_type IN ('causal', 'semantic', 'temporal', 'contradictory')),
      strength REAL NOT NULL CHECK(strength >= 0 AND strength <= 1),
      created_at TEXT NOT NULL
    );
  `);

  // Create indexes
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_traces_agent_session ON traces(agent_id, session_id);
    CREATE INDEX IF NOT EXISTS idx_traces_encode_status ON traces(encode_status) WHERE encode_status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_traces_significance ON traces(significance);
    CREATE INDEX IF NOT EXISTS idx_encodes_consolidation ON encodes(consolidation_status) WHERE consolidation_status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_encodes_agent ON encodes(agent_id);
    CREATE INDEX IF NOT EXISTS idx_encodes_memory_type ON encodes(memory_type);
    CREATE INDEX IF NOT EXISTS idx_encodes_shared ON encodes(is_shared) WHERE is_shared = 1;
    CREATE INDEX IF NOT EXISTS idx_bonds_encode_a ON bonds(encode_id_a);
    CREATE INDEX IF NOT EXISTS idx_bonds_encode_b ON bonds(encode_id_b);
    CREATE INDEX IF NOT EXISTS idx_bonds_type ON bonds(bond_type);
  `);

  console.log('Database initialized at:', config.databasePath);
}

export function runMigrations(): void {
  const database = getDb();
  
  console.log('Running migrations...');

  // Migration: Add significance column to traces if not exists
  try {
    const significanceCheck = database.prepare(`
      SELECT COUNT(*) as count FROM pragma_table_info('traces') WHERE name = 'significance'
    `).get() as any;
    
    if (significanceCheck.count === 0) {
      console.log('  → Adding significance column to traces...');
      database.exec(`ALTER TABLE traces ADD COLUMN significance INTEGER DEFAULT 5 CHECK(significance >= 1 AND significance <= 10)`);
      
      // Migrate existing traces: identity traces get significance 9, others get 5
      database.exec(`
        UPDATE traces SET significance = CASE 
          WHEN is_identity_trace = 1 THEN 9
          ELSE 5
        END
      `);
      console.log('  → Migrated existing traces significance');
    }
  } catch (e) {
    console.error('  → Error adding significance column:', e);
  }

  // Migration: Add memory_type column to encodes if not exists
  try {
    const memoryTypeCheck = database.prepare(`
      SELECT COUNT(*) as count FROM pragma_table_info('encodes') WHERE name = 'memory_type'
    `).get() as any;
    
    if (memoryTypeCheck.count === 0) {
      console.log('  → Adding memory_type column to encodes...');
      database.exec(`ALTER TABLE encodes ADD COLUMN memory_type TEXT DEFAULT 'episodic' CHECK(memory_type IN ('episodic', 'semantic', 'procedural', 'self_model'))`);
      
      // Since we can't easily join with JSON array, we'll use a simpler approach
      // Default all existing to episodic, and the encode pipeline will reclassify on next run
      database.exec(`UPDATE encodes SET memory_type = 'episodic' WHERE memory_type IS NULL`);
      console.log('  → Migrated existing encodes to episodic (will reclassify on next encode)');
    }
  } catch (e) {
    console.error('  → Error adding memory_type column:', e);
  }

  // Migration: Create bonds table if not exists
  try {
    const bondsCheck = database.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='bonds'
    `).get() as any;
    
    if (!bondsCheck) {
      console.log('  → Creating bonds table...');
      database.exec(`
        CREATE TABLE bonds (
          bond_id TEXT PRIMARY KEY,
          encode_id_a TEXT NOT NULL,
          encode_id_b TEXT NOT NULL,
          bond_type TEXT NOT NULL CHECK(bond_type IN ('causal', 'semantic', 'temporal', 'contradictory')),
          strength REAL NOT NULL CHECK(strength >= 0 AND strength <= 1),
          created_at TEXT NOT NULL
        )
      `);
      database.exec(`CREATE INDEX idx_bonds_encode_a ON bonds(encode_id_a)`);
      database.exec(`CREATE INDEX idx_bonds_encode_b ON bonds(encode_id_b)`);
      database.exec(`CREATE INDEX idx_bonds_type ON bonds(bond_type)`);
    }
  } catch (e) {
    console.error('  → Error creating bonds table:', e);
  }

  // Migration: Create additional indexes
  try {
    database.exec(`CREATE INDEX IF NOT EXISTS idx_traces_significance ON traces(significance)`);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_encodes_memory_type ON encodes(memory_type)`);
  } catch (e) {
    // Indexes may already exist
  }

  console.log('Migrations complete.');
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
