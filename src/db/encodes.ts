import { getDb } from './init.js';

export type ConsolidationStatus = 'pending' | 'consolidated' | 'pruned';

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
  consolidation_status: ConsolidationStatus;
  is_shared: boolean;
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
  is_shared: boolean;
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
      compression_ratio, consolidation_status, is_shared, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
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
    input.is_shared ? 1 : 0,
    input.created_at
  );

  // Insert into vector table for similarity search
  const vecStmt = db.prepare(`
    INSERT INTO vec_encodes (encode_id, embedding) VALUES (?, ?)
  `);
  vecStmt.run(input.encode_id, new Float32Array(input.semantic_embedding));

  return {
    ...input,
    consolidation_status: 'pending',
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
    consolidation_status: row.consolidation_status as ConsolidationStatus,
    is_shared: row.is_shared === 1,
    created_at: row.created_at
  };
}
