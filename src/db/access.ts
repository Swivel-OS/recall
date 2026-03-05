import { getDb } from './init.js';

export interface AccessLogEntry {
  access_id?: number;
  encode_id: string;
  agent_id: string;
  access_type: 'query' | 'boot' | 'bond_traversal' | 'explicit_recall';
  query_text?: string;
  relevance_score?: number;
  access_ts: string;
  context?: string;
}

export interface MemoryReinforcement {
  encode_id: string;
  total_accesses: number;
  recent_accesses_7d: number;
  recent_accesses_30d: number;
  reinforcement_score: number;
  last_access_ts: string | null;
  first_access_ts: string | null;
  updated_at: string;
}

/**
 * Log a memory access event.
 * Called every time a memory is recalled (query, boot, etc.)
 */
export function logMemoryAccess(entry: AccessLogEntry): void {
  const db = getDb();
  
  const stmt = db.prepare(`
    INSERT INTO memory_access_log 
      (encode_id, agent_id, access_type, query_text, relevance_score, access_ts, context)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  
  stmt.run(
    entry.encode_id,
    entry.agent_id,
    entry.access_type,
    entry.query_text || null,
    entry.relevance_score || null,
    entry.access_ts,
    entry.context || null
  );
  
  // Update reinforcement state for this memory
  updateReinforcementState(entry.encode_id, entry.access_ts);
}

/**
 * Update reinforcement state when a memory is accessed.
 * Applies strengthening based on access patterns.
 */
function updateReinforcementState(encode_id: string, access_ts: string): void {
  const db = getDb();
  
  // Get current state or create new
  const row = db.prepare('SELECT * FROM memory_reinforcement WHERE encode_id = ?').get(encode_id) as any;
  
  const now = new Date(access_ts);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  
  if (!row) {
    // First access — create record
    const insertStmt = db.prepare(`
      INSERT INTO memory_reinforcement
        (encode_id, total_accesses, recent_accesses_7d, recent_accesses_30d, 
         reinforcement_score, last_access_ts, first_access_ts, updated_at)
      VALUES (?, 1, 1, 1, 1.0, ?, ?, ?)
    `);
    insertStmt.run(encode_id, access_ts, access_ts, access_ts);
    return;
  }
  
  // Count accesses in windows
  const countStmt = db.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN access_ts > ? THEN 1 ELSE 0 END) as recent_7d,
      SUM(CASE WHEN access_ts > ? THEN 1 ELSE 0 END) as recent_30d
    FROM memory_access_log
    WHERE encode_id = ?
  `);
  const counts = countStmt.get(sevenDaysAgo.toISOString(), thirtyDaysAgo.toISOString(), encode_id) as any;
  
  // Calculate reinforcement score
  // Base: 1.0, +0.1 per total access (capped at 2.0), +0.2 if accessed in last 7d
  let reinforcement = 1.0 + (Math.min(counts.total, 10) * 0.1);
  if (counts.recent_7d > 0) reinforcement += 0.2;
  if (counts.recent_30d > 3) reinforcement += 0.1;  // Frequently accessed this month
  
  // Cap at 3.0x (very reinforced memories are 3x stronger against decay)
  reinforcement = Math.min(3.0, reinforcement);
  
  // Update record
  const updateStmt = db.prepare(`
    UPDATE memory_reinforcement
    SET total_accesses = ?,
        recent_accesses_7d = ?,
        recent_accesses_30d = ?,
        reinforcement_score = ?,
        last_access_ts = ?,
        updated_at = ?
    WHERE encode_id = ?
  `);
  
  updateStmt.run(
    counts.total,
    counts.recent_7d,
    counts.recent_30d,
    reinforcement,
    access_ts,
    access_ts,
    encode_id
  );
}

/**
 * Get reinforcement score for a memory.
 * Returns 1.0 if no reinforcement record (baseline).
 */
export function getReinforcementScore(encode_id: string): number {
  const db = getDb();
  const row = db.prepare('SELECT reinforcement_score FROM memory_reinforcement WHERE encode_id = ?').get(encode_id) as any;
  return row?.reinforcement_score || 1.0;
}

/**
 * Get access stats for a memory.
 */
export function getAccessStats(encode_id: string): MemoryReinforcement | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM memory_reinforcement WHERE encode_id = ?').get(encode_id) as any;
  
  if (!row) return null;
  
  return {
    encode_id: row.encode_id,
    total_accesses: row.total_accesses,
    recent_accesses_7d: row.recent_accesses_7d,
    recent_accesses_30d: row.recent_accesses_30d,
    reinforcement_score: row.reinforcement_score,
    last_access_ts: row.last_access_ts,
    first_access_ts: row.first_access_ts,
    updated_at: row.updated_at
  };
}

/**
 * Get most accessed memories for an agent.
 * Useful for "what do I keep thinking about" insights.
 */
export function getHotMemories(agent_id: string, limit: number = 10): Array<{ encode_id: string; score: number; accesses: number }> {
  const db = getDb();
  
  // Join with encodes to filter by agent
  const rows = db.prepare(`
    SELECT mr.encode_id, mr.reinforcement_score, mr.recent_accesses_7d
    FROM memory_reinforcement mr
    JOIN encodes e ON e.encode_id = mr.encode_id
    WHERE e.agent_id = ?
    ORDER BY mr.recent_accesses_7d DESC, mr.reinforcement_score DESC
    LIMIT ?
  `).all(agent_id, limit) as any[];
  
  return rows.map(r => ({
    encode_id: r.encode_id,
    score: r.reinforcement_score,
    accesses: r.recent_accesses_7d
  }));
}

/**
 * Run consolidation — update all reinforcement scores.
 * Should be called periodically (daily/weekly).
 */
export function runConsolidation(): { processed: number; reinforced: number; pruned: number } {
  const db = getDb();
  const now = new Date().toISOString();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  
  // Log start
  const startStmt = db.prepare('INSERT INTO consolidation_log (started_at) VALUES (?)');
  const runId = startStmt.run(now).lastInsertRowid;
  
  // Process all memories with reinforcement records
  const memories = db.prepare('SELECT encode_id FROM memory_reinforcement').all() as any[];
  let reinforced = 0;
  let pruned = 0;
  
  for (const { encode_id } of memories) {
    // Recalculate stats
    const counts = db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN access_ts > ? THEN 1 ELSE 0 END) as recent_7d,
        SUM(CASE WHEN access_ts > ? THEN 1 ELSE 0 END) as recent_30d,
        MAX(access_ts) as last_access
      FROM memory_access_log
      WHERE encode_id = ?
    `).get(sevenDaysAgo, thirtyDaysAgo, encode_id) as any;
    
    if (counts.total === 0) {
      // No accesses — prune the reinforcement record (memory has decayed fully)
      db.prepare('DELETE FROM memory_reinforcement WHERE encode_id = ?').run(encode_id);
      pruned++;
      continue;
    }
    
    // Recalculate reinforcement
    let reinforcement = 1.0 + (Math.min(counts.total, 10) * 0.1);
    if (counts.recent_7d > 0) reinforcement += 0.2;
    if (counts.recent_30d > 3) reinforcement += 0.1;
    reinforcement = Math.min(3.0, reinforcement);
    
    // Update
    db.prepare(`
      UPDATE memory_reinforcement
      SET total_accesses = ?,
          recent_accesses_7d = ?,
          recent_accesses_30d = ?,
          reinforcement_score = ?,
          last_access_ts = ?,
          updated_at = ?
      WHERE encode_id = ?
    `).run(counts.total, counts.recent_7d, counts.recent_30d, reinforcement, counts.last_access, now, encode_id);
    
    reinforced++;
  }
  
  // Log completion
  db.prepare(`
    UPDATE consolidation_log
    SET completed_at = ?,
        memories_processed = ?,
        memories_reinforced = ?,
        memories_pruned = ?,
        notes = ?
    WHERE run_id = ?
  `).run(now, memories.length, reinforced, pruned, 'Consolidation complete', runId);
  
  return { processed: memories.length, reinforced, pruned };
}

/**
 * Get consolidation history.
 */
export function getConsolidationHistory(limit: number = 10): any[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM consolidation_log
    ORDER BY started_at DESC
    LIMIT ?
  `).all(limit) as any[];
}
