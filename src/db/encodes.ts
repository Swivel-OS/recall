import { getDb } from './init.js';

export type MemoryType = 'episodic' | 'semantic' | 'procedural' | 'self_model';
export type ConsolidationStatus = 'pending' | 'consolidated' | 'pruned';

// Decay rates per memory type (daily)
export const DECAY_RATES: Record<MemoryType, number> = {
  'self_model': 0.01,    // Very slow decay
  'semantic': 0.02,      // Slow decay
  'procedural': 0.03,    // Moderate decay
  'episodic': 0.07       // Fast decay
};

// Significance-based decay modifiers
export function getDecayModifier(significance: number): number {
  if (significance >= 9) return 0.5;  // Half decay for critical memories
  if (significance >= 7) return 0.7;  // Reduced decay for high significance
  if (significance >= 4) return 1.0;  // Normal decay
  return 1.3; // Accelerated decay for low significance
}

// Recency boost multipliers for "Dude Where's My Car" problem
// Recent memories get boosted to compete with older, heavily-reinforced ones
export function getRecencyBoost(daysOld: number): number {
  if (daysOld <= 1) return 2.0;      // Last 24h: 2x boost
  if (daysOld <= 2) return 1.5;      // 24-48h: 1.5x boost
  if (daysOld <= 3) return 1.2;      // 48-72h: 1.2x boost
  return 1.0;                        // >72h: no boost
}

// Import reinforcement scoring
import { getReinforcementScore, logMemoryAccess } from './access.js';

/**
 * Calculate final memory strength score.
 * Combines: base similarity × decay × recency × reinforcement
 */
export function calculateMemoryStrength(
  baseScore: number,
  daysOld: number,
  memoryType: MemoryType,
  significance: number,
  encodeId: string,
  agentId: string,
  accessType: 'query' | 'boot' | 'bond_traversal' = 'query'
): { finalScore: number; logged: boolean } {
  // Apply memory type decay
  const decayRate = DECAY_RATES[memoryType];
  const decayModifier = getDecayModifier(significance);
  const effectiveDecay = decayRate * decayModifier;
  const decayedScore = baseScore * Math.pow(1 - effectiveDecay, daysOld);
  
  // Apply recency boost
  const recencyBoost = getRecencyBoost(daysOld);
  
  // Apply reinforcement (memories that are accessed get stronger)
  const reinforcementScore = getReinforcementScore(encodeId);
  
  // Combined: decayed × recency × reinforcement
  const finalScore = decayedScore * recencyBoost * reinforcementScore;
  
  // Log this access for future reinforcement
  logMemoryAccess({
    encode_id: encodeId,
    agent_id: agentId,
    access_type: accessType,
    relevance_score: finalScore,
    access_ts: new Date().toISOString()
  });
  
  return { finalScore, logged: true };
}

export interface Encode {
  encode_id: string;
  agent_id: string;
  source_trace_ids: string[];
  session_id: string;
  timestamp_encoded: string;
  semantic_summary: string;
  semantic_embedding: Buffer;
  embedding_model: string;
  emotional_valence: number;
  emotional_tags: string[] | null;
  importance_score: number;
  importance_reason: string | null;
  topics: string[];
  entities: Record<string, string[]> | null;
  compression_ratio: number;
  memory_type: MemoryType;
  consolidation_status: ConsolidationStatus;
  is_shared: boolean;
  basins: string[];
  created_at: string;
}

export interface CreateEncodeInput {
  encode_id: string;
  agent_id: string;
  source_trace_ids: string[];
  session_id: string;
  timestamp_encoded: string;
  semantic_summary: string;
  semantic_embedding: number[];
  embedding_model: string;
  emotional_valence: number;
  emotional_tags: string[] | null;
  importance_score: number;
  importance_reason: string | null;
  topics: string[];
  entities: Record<string, string[]> | null;
  compression_ratio: number;
  memory_type: MemoryType;
  is_shared: boolean;
  basins?: string[];
  created_at: string;
}

export function createEncode(input: CreateEncodeInput): Encode {
  const db = getDb();
  
  // Insert into main encodes table
  const stmt = db.prepare(`
    INSERT INTO encodes (
      encode_id, agent_id, source_trace_ids, session_id, timestamp_encoded,
      semantic_summary, semantic_embedding, embedding_model, emotional_valence,
      emotional_tags, importance_score, importance_reason, topics, entities,
      compression_ratio, memory_type, consolidation_status, is_shared, basins, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `);

  const embeddingBlob = Buffer.from(new Float32Array(input.semantic_embedding).buffer);

  stmt.run(
    input.encode_id,
    input.agent_id,
    JSON.stringify(input.source_trace_ids),
    input.session_id,
    input.timestamp_encoded,
    input.semantic_summary,
    embeddingBlob,
    input.embedding_model,
    input.emotional_valence,
    input.emotional_tags ? JSON.stringify(input.emotional_tags) : null,
    input.importance_score,
    input.importance_reason,
    JSON.stringify(input.topics),
    input.entities ? JSON.stringify(input.entities) : null,
    input.compression_ratio,
    input.memory_type,
    input.is_shared ? 1 : 0,
    JSON.stringify(input.basins || []),
    input.created_at
  );

  // Insert into vector table for similarity search
  const vecStmt = db.prepare(`
    INSERT INTO vec_encodes (encode_id, embedding) VALUES (?, ?)
  `);
  vecStmt.run(input.encode_id, new Float32Array(input.semantic_embedding));

  return {
    ...input,
    basins: input.basins || [],
    consolidation_status: 'pending' as ConsolidationStatus,
    semantic_embedding: embeddingBlob
  };
}

export function getEncodeById(encodeId: string): Encode | null {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM encodes WHERE encode_id = ?');
  const row = stmt.get(encodeId) as any;
  
  if (!row) return null;
  
  return rowToEncode(row);
}

export function semanticSearch(queryEmbedding: number[], limit: number = 10): Array<{ encode: Encode; distance: number }> {
  const db = getDb();
  
  const queryVec = new Float32Array(queryEmbedding);
  
  // Use sqlite-vec for KNN search
  const stmt = db.prepare(`
    SELECT 
      e.*,
      vec_distance_L2(v.embedding, ?) as distance
    FROM vec_encodes v
    JOIN encodes e ON v.encode_id = e.encode_id
    ORDER BY distance ASC
    LIMIT ?
  `);
  
  const rows = stmt.all(queryVec, limit) as any[];
  
  return rows.map(row => ({
    encode: rowToEncode(row),
    distance: row.distance
  }));
}

export function semanticSearchWithDecay(
  queryEmbedding: number[], 
  limit: number = 10,
  agentId?: string,
  significanceThreshold: number = 0
): Array<{ encode: Encode; distance: number; adjusted_score: number; days_old: number; recency_boost: number; reinforcement: number }> {
  const db = getDb();
  const now = new Date();
  
  const queryVec = new Float32Array(queryEmbedding);
  
  // Get more results initially to allow for decay filtering
  const stmt = db.prepare(`
    SELECT 
      e.*,
      vec_distance_L2(v.embedding, ?) as distance
    FROM vec_encodes v
    JOIN encodes e ON v.encode_id = e.encode_id
    ORDER BY distance ASC
    LIMIT ?
  `);
  
  const rows = stmt.all(queryVec, limit * 3) as any[];
  
  // Apply full temporal scoring: decay × recency × reinforcement
  const results = rows.map(row => {
    const encode = rowToEncode(row);
    const encodeDate = new Date(encode.timestamp_encoded);
    const daysOld = Math.max(0, (now.getTime() - encodeDate.getTime()) / (1000 * 60 * 60 * 24));
    
    // Calculate base similarity from distance
    const rawScore = 1 / (1 + row.distance); // Convert distance to similarity (0-1)
    
    // Get significance from trace (default 5 if not available)
    const significance = 5; // TODO: Join with traces table to get actual significance
    
    // Calculate full memory strength with reinforcement
    const { finalScore } = calculateMemoryStrength(
      rawScore,
      daysOld,
      encode.memory_type,
      significance,
      encode.encode_id,
      agentId || encode.agent_id,
      'query'
    );
    
    const recencyBoost = getRecencyBoost(daysOld);
    const reinforcementScore = getReinforcementScore(encode.encode_id);
    
    return {
      encode,
      distance: row.distance,
      adjusted_score: finalScore,
      days_old: Math.round(daysOld),
      recency_boost: recencyBoost,
      reinforcement: reinforcementScore
    };
  });
  
  // Filter by significance threshold and sort by adjusted score
  return results
    .filter(r => r.adjusted_score >= significanceThreshold)
    .sort((a, b) => b.adjusted_score - a.adjusted_score)
    .slice(0, limit);
}

export function getEncodeCount(): number {
  const db = getDb();
  const stmt = db.prepare('SELECT COUNT(*) as count FROM encodes');
  const row = stmt.get() as any;
  return row.count;
}

export function getEncodeCountByStatus(status: ConsolidationStatus): number {
  const db = getDb();
  const stmt = db.prepare('SELECT COUNT(*) as count FROM encodes WHERE consolidation_status = ?');
  const row = stmt.get(status) as any;
  return row.count;
}

export function getRecentEncodesForAgent(agentId: string, limit: number = 5): Encode[] {
  const db = getDb();

  // Query recent encodes for this agent, prioritizing by importance and recency
  const stmt = db.prepare(`
    SELECT * FROM encodes 
    WHERE agent_id = ? 
    ORDER BY importance_score DESC, timestamp_encoded DESC 
    LIMIT ?
  `);

  const rows = stmt.all(agentId, limit) as any[];
  return rows.map(rowToEncode);
}

export function getEncodesForBoot(
  agentId: string, 
  limit: number = 5,
  includeRelated: boolean = true
): Array<{ encode: Encode; related?: Encode[]; cluster_size?: number; is_user_fact?: boolean }> {
  const db = getDb();

  // First, get any user_stated_fact tagged encodes (highest priority)
  const userFactStmt = db.prepare(`
    SELECT e.*, COALESCE(t.significance, 5) as trace_significance, 1 as is_user_fact
    FROM encodes e
    LEFT JOIN traces t ON t.trace_id = json_extract(e.source_trace_ids, '$[0]')
    WHERE e.agent_id = ? 
      AND t.tags IS NOT NULL
      AND json_extract(t.tags, '$') LIKE '%user_stated_fact%'
    ORDER BY e.timestamp_encoded DESC
    LIMIT ?
  `);

  const userFactRows = userFactStmt.all(agentId, limit) as any[];
  const userFactEncodes = userFactRows.map(rowToEncode);
  const userFactIds = new Set(userFactEncodes.map(e => e.encode_id));

  // Get high-quality recent encodes with significance weighting
  const stmt = db.prepare(`
    SELECT e.*, COALESCE(t.significance, 5) as trace_significance, 0 as is_user_fact
    FROM encodes e
    LEFT JOIN traces t ON t.trace_id = json_extract(e.source_trace_ids, '$[0]')
    WHERE e.agent_id = ? 
      AND e.encode_id NOT IN (${userFactIds.size > 0 ? Array(userFactIds.size).fill('?').join(',') : "''"})
    ORDER BY 
      CASE e.memory_type
        WHEN 'self_model' THEN 4
        WHEN 'semantic' THEN 3
        WHEN 'procedural' THEN 2
        ELSE 1
      END DESC,
      COALESCE(t.significance, 5) DESC,
      e.importance_score DESC,
      e.timestamp_encoded DESC 
    LIMIT ?
  `);

  const params = userFactIds.size > 0 
    ? [agentId, ...Array.from(userFactIds), limit]
    : [agentId, limit];
  const rows = stmt.all(...params) as any[];
  const encodes = userFactEncodes.concat(rows.map(rowToEncode)).slice(0, limit);

  if (!includeRelated) {
    return encodes.map(e => ({ encode: e }));
  }

  // Get related encodes via bonds
  const results: Array<{ encode: Encode; related?: Encode[]; cluster_size?: number; is_user_fact?: boolean }> = [];
  
  for (const encode of encodes) {
    const relatedStmt = db.prepare(`
      SELECT e.* 
      FROM encodes e
      JOIN bonds b ON (b.encode_id_a = e.encode_id OR b.encode_id_b = e.encode_id)
      WHERE (b.encode_id_a = ? OR b.encode_id_b = ?)
        AND e.encode_id != ?
      ORDER BY b.strength DESC
      LIMIT 3
    `);
    
    const relatedRows = relatedStmt.all(encode.encode_id, encode.encode_id, encode.encode_id) as any[];
    const related = relatedRows.map(rowToEncode);
    
    // Get cluster size
    const clusterStmt = db.prepare(`
      SELECT COUNT(*) as count FROM bonds 
      WHERE encode_id_a = ? OR encode_id_b = ?
    `);
    const clusterRow = clusterStmt.get(encode.encode_id, encode.encode_id) as any;
    
    results.push({
      encode,
      related: related.length > 0 ? related : undefined,
      cluster_size: clusterRow.count,
      is_user_fact: userFactIds.has(encode.encode_id)
    });
  }

  return results;
}

export function findSimilarEncodes(
  embedding: number[], 
  threshold: number = 0.8, 
  excludeId?: string
): Array<{ encode: Encode; similarity: number }> {
  const db = getDb();
  const queryVec = new Float32Array(embedding);
  
  // Use cosine similarity threshold
  // L2 distance of ~0.632 corresponds to cosine similarity of ~0.8 for normalized vectors
  const maxDistance = Math.sqrt(2 * (1 - threshold));
  
  let sql = `
    SELECT 
      e.*,
      vec_distance_L2(v.embedding, ?) as distance
    FROM vec_encodes v
    JOIN encodes e ON v.encode_id = e.encode_id
    WHERE vec_distance_L2(v.embedding, ?) < ?
  `;
  
  if (excludeId) {
    sql += ` AND e.encode_id != ?`;
  }
  
  sql += ` ORDER BY distance ASC LIMIT 20`;
  
  const stmt = db.prepare(sql);
  const params = excludeId 
    ? [queryVec, queryVec, maxDistance, excludeId]
    : [queryVec, queryVec, maxDistance];
  
  const rows = stmt.all(...params) as any[];
  
  return rows.map(row => ({
    encode: rowToEncode(row),
    similarity: 1 - (row.distance * row.distance) / 2 // Approximate cosine from L2
  }));
}

// Query encodes by basin name
export function findEncodesByBasin(basin: string, limit: number = 50): Encode[] {
  const db = getDb();
  // JSON array contains — SQLite JSON1 extension
  const rows = db.prepare(`
    SELECT * FROM encodes
    WHERE basins LIKE ?
    ORDER BY importance_score DESC, created_at DESC
    LIMIT ?
  `).all(`%"${basin}"%`, limit) as any[];
  return rows.map(rowToEncode);
}

// Query encodes by basin + topic intersection
export function findEncodesByBasinAndTopic(basin: string, topic: string, limit: number = 50): Encode[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM encodes
    WHERE basins LIKE ? AND topics LIKE ?
    ORDER BY importance_score DESC, created_at DESC
    LIMIT ?
  `).all(`%"${basin}"%`, `%"${topic}"%`, limit) as any[];
  return rows.map(rowToEncode);
}

// Get basin distribution across all encodes
export function getBasinStats(): Record<string, number> {
  const db = getDb();
  const rows = db.prepare(`SELECT basins FROM encodes WHERE basins != '[]'`).all() as any[];
  const stats: Record<string, number> = {};
  for (const row of rows) {
    try {
      const basins = JSON.parse(row.basins);
      for (const b of basins) {
        stats[b] = (stats[b] || 0) + 1;
      }
    } catch {}
  }
  return stats;
}

function rowToEncode(row: any): Encode {
  return {
    encode_id: row.encode_id,
    agent_id: row.agent_id,
    source_trace_ids: JSON.parse(row.source_trace_ids),
    session_id: row.session_id,
    timestamp_encoded: row.timestamp_encoded,
    semantic_summary: row.semantic_summary,
    semantic_embedding: row.semantic_embedding,
    embedding_model: row.embedding_model,
    emotional_valence: row.emotional_valence,
    emotional_tags: row.emotional_tags ? JSON.parse(row.emotional_tags) : null,
    importance_score: row.importance_score,
    importance_reason: row.importance_reason,
    topics: JSON.parse(row.topics),
    entities: row.entities ? JSON.parse(row.entities) : null,
    compression_ratio: row.compression_ratio,
    memory_type: (row.memory_type || 'episodic') as MemoryType,
    consolidation_status: row.consolidation_status as ConsolidationStatus,
    is_shared: row.is_shared === 1,
    basins: row.basins ? JSON.parse(row.basins) : [],
    created_at: row.created_at
  };
}
