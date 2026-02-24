# RECALL Schema Reference

Complete database schema for RECALL v0.3.0

---

## Tables

### traces — Raw Event Captures

Immutable records of agent experiences. One trace per meaningful interaction.

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `trace_id` | TEXT | PRIMARY KEY | UUID v4, globally unique |
| `agent_id` | TEXT | NOT NULL | Agent identifier (e.g., `forge`, `swiv`) |
| `session_id` | TEXT | NOT NULL | Session grouping key |
| `session_seq` | INTEGER | NOT NULL | Order within session (1-indexed) |
| `timestamp_start` | TEXT | NOT NULL | ISO 8601 timestamp |
| `timestamp_end` | TEXT | NOT NULL | ISO 8601 timestamp |
| `content_raw` | TEXT | NOT NULL | Full raw content |
| `content_hash` | TEXT | NOT NULL | SHA-256 of content (dedup) |
| `participants` | TEXT | NOT NULL | JSON array of participant IDs |
| `channel` | TEXT | NOT NULL | Source surface (`discord`, `terminal`, etc.) |
| `trace_type` | TEXT | NOT NULL | `conversation` \| `decision` \| `task_completion` \| `error` \| `handoff` |
| `is_identity_trace` | INTEGER | NOT NULL, DEFAULT 0 | True if contains identity-sensitive content |
| `significance` | INTEGER | DEFAULT 5, CHECK 1-10 | Importance score (v0.3+) |
| `encode_status` | TEXT | NOT NULL, DEFAULT 'pending' | `pending` \| `encoded` \| `skipped` |
| `created_at` | TEXT | NOT NULL | ISO 8601 record creation time |

**Notes:**
- Traces are immutable. Once created, only `encode_status` and `significance` can change.
- `significance` is auto-calculated on capture (v0.3+) based on content analysis
- Identity traces force `is_shared = false` on derived encodes

---

### encodes — Structured Memories

Compressed, queryable memory records derived from traces.

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `encode_id` | TEXT | PRIMARY KEY | UUID v4, globally unique |
| `agent_id` | TEXT | NOT NULL | Owning agent |
| `source_trace_ids` | TEXT | NOT NULL | JSON array of source trace UUIDs |
| `session_id` | TEXT | NOT NULL | Denormalized from trace for fast queries |
| `timestamp_encoded` | TEXT | NOT NULL | When encode pipeline processed this |
| `semantic_summary` | TEXT | NOT NULL | 1-3 sentence human-readable summary |
| `semantic_embedding` | BLOB | NOT NULL | Binary embedding vector (1536 dims) |
| `embedding_model` | TEXT | NOT NULL | Model used (e.g., `text-embedding-3-small`) |
| `emotional_valence` | REAL | NOT NULL | Sentiment: -1.0 (negative) to 1.0 (positive) |
| `emotional_tags` | TEXT | NULL | JSON array of labels: `["frustration", "breakthrough"]` |
| `importance_score` | REAL | NOT NULL | 0.0 to 1.0, for prioritization |
| `importance_reason` | TEXT | NULL | Human-readable explanation of score |
| `topics` | TEXT | NOT NULL | JSON array of extracted topics |
| `entities` | TEXT | NULL | JSON object: `{"people": ["JP"], "projects": ["RECALL"]}` |
| `compression_ratio` | REAL | NOT NULL | `len(content_raw) / len(summary)` |
| `memory_type` | TEXT | DEFAULT 'episodic' | `episodic` \| `semantic` \| `procedural` \| `self_model` |
| `consolidation_status` | TEXT | NOT NULL, DEFAULT 'pending' | `pending` \| `consolidated` \| `pruned` |
| `is_shared` | INTEGER | NOT NULL, DEFAULT 0 | Cross-agent readable if true |
| `created_at` | TEXT | NOT NULL | ISO 8601 record creation time |

**Notes:**
- Embeddings are 1536-dimensional float32 vectors, stored as binary BLOBs
- The virtual table `vec_encodes` mirrors this for vector search
- `memory_type` is auto-classified during encode (v0.3+)
- `is_shared` defaults: semantic/procedural = true, episodic = depends on trace_type, self_model = always false

---

### bonds — Memory Connections

Molecular bonds connecting related encodes.

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `bond_id` | TEXT | PRIMARY KEY | Composite: `{encode_a}_{encode_b}_{type}` |
| `encode_id_a` | TEXT | NOT NULL | First encode (ordered lexicographically) |
| `encode_id_b` | TEXT | NOT NULL | Second encode |
| `bond_type` | TEXT | NOT NULL | `causal` \| `semantic` \| `temporal` \| `contradictory` |
| `strength` | REAL | NOT NULL, CHECK 0-1 | Bond strength (higher = stronger connection) |
| `created_at` | TEXT | NOT NULL | ISO 8601 bond creation time |

**Notes:**
- `encode_id_a` < `encode_id_b` lexicographically to prevent duplicates
- Max 10 bonds created per new encode (keeps graph sparse)
- Contradictory bonds log warnings but don't auto-resolve

#### Bond Type Semantics

| Type | Detection Criteria | Strength Modifier |
|------|-------------------|-------------------|
| **Causal** | Causal language present + temporal proximity (<1 hour) | 1.2x boost |
| **Semantic** | Embedding similarity > 0.8, no other bond type applies | Base similarity |
| **Temporal** | Same session_id OR timestamps within 1 hour | 1.1x if same session |
| **Contradictory** | High similarity (>0.85) + contradiction markers present | 0.9x reduction |

**Contradiction markers:** `however`, `but`, `although`, `was wrong`, `incorrect`, `not true`, etc.

**Causal indicators:** `because`, `led to`, `resulted in`, `caused`, `therefore`, etc.

---

## Virtual Tables

### vec_encodes — Vector Search Index

SQLite-vec virtual table for efficient similarity search.

```sql
CREATE VIRTUAL TABLE vec_encodes USING vec0(
  encode_id TEXT PRIMARY KEY,
  embedding FLOAT[1536]
);
```

**Notes:**
- Mirrors `encodes.encode_id` — don't insert without corresponding encodes row
- Query with `vec_distance_L2()` or `vec_distance_cosine()`
- 1536 dimensions matches text-embedding-3-small

---

## Indexes

### Trace Indexes

```sql
-- Fast agent + session lookups
CREATE INDEX idx_traces_agent_session ON traces(agent_id, session_id);

-- Encode pipeline queue
CREATE INDEX idx_traces_encode_status ON traces(encode_status) 
  WHERE encode_status = 'pending';

-- Significance-based queries
CREATE INDEX idx_traces_significance ON traces(significance);
```

### Encode Indexes

```sql
-- Consolidation pipeline queue
CREATE INDEX idx_encodes_consolidation ON encodes(consolidation_status) 
  WHERE consolidation_status = 'pending';

-- Agent-scoped queries
CREATE INDEX idx_encodes_agent ON encodes(agent_id);

-- Memory type filtering
CREATE INDEX idx_encodes_memory_type ON encodes(memory_type);

-- Shared episodic layer reads
CREATE INDEX idx_encodes_shared ON encodes(is_shared) 
  WHERE is_shared = 1;
```

### Bond Indexes

```sql
-- Traverse from encode A
CREATE INDEX idx_bonds_encode_a ON bonds(encode_id_a);

-- Traverse from encode B
CREATE INDEX idx_bonds_encode_b ON bonds(encode_id_b);

-- Bond type filtering
CREATE INDEX idx_bonds_type ON bonds(bond_type);
```

---

## Type Reference

### Trace Types

| Type | Description | Default Significance |
|------|-------------|---------------------|
| `conversation` | General dialogue | 4 |
| `decision` | Commitment to action | 7 |
| `task_completion` | Finished work | 6 |
| `error` | Failure or problem | 7 |
| `handoff` | Agent delegation | 5 |

### Memory Types

| Type | Decay Rate | Sharing | Description |
|------|------------|---------|-------------|
| `episodic` | 7% / day | Conditional | Events, conversations, what happened |
| `semantic` | 2% / day | Always | Facts, knowledge, definitions |
| `procedural` | 3% / day | Always | Skills, patterns, how-to |
| `self_model` | 1% / day | Never | Identity, values, core beliefs |

### Encode Status Values

| Value | Meaning |
|-------|---------|
| `pending` | Waiting for encode pipeline |
| `encoded` | Successfully processed |
| `skipped` | Low signal, not worth encoding |

### Consolidation Status Values

| Value | Meaning |
|-------|---------|
| `pending` | Not yet consolidated |
| `consolidated` | Merged with other memories |
| `pruned` | Removed as low-value |

---

## Query Patterns

### Get Pending Traces for Encode

```sql
SELECT * FROM traces 
WHERE encode_status = 'pending' 
ORDER BY significance DESC, created_at ASC;
```

### Semantic Search (Basic)

```sql
SELECT e.*, vec_distance_L2(v.embedding, ?) as distance
FROM vec_encodes v
JOIN encodes e ON v.encode_id = e.encode_id
ORDER BY distance ASC
LIMIT 10;
```

### Decay-Adjusted Search

Application handles decay calculation post-query:

```typescript
const decayRate = DECAY_RATES[memory_type];  // e.g., 0.07
const daysOld = (now - encodeDate) / (1000 * 60 * 60 * 24);
const adjustedScore = rawScore * Math.pow(1 - decayRate, daysOld);
```

### Boot Context Query

```sql
SELECT e.*, COALESCE(t.significance, 5) as trace_significance
FROM encodes e
LEFT JOIN traces t ON t.trace_id = json_extract(e.source_trace_ids, '$[0]')
WHERE e.agent_id = ?
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
LIMIT 5;
```

### Get Memory Cluster via Bonds

```sql
-- Get related encodes
SELECT e.*, b.bond_type, b.strength
FROM encodes e
JOIN bonds b ON (b.encode_id_a = e.encode_id OR b.encode_id_b = e.encode_id)
WHERE (b.encode_id_a = ? OR b.encode_id_b = ?)
  AND e.encode_id != ?
ORDER BY b.strength DESC;
```

### Find Contradictions

```sql
SELECT b.*, 
       a.semantic_summary as memory_a,
       b_encode.semantic_summary as memory_b
FROM bonds b
JOIN encodes a ON a.encode_id = b.encode_id_a
JOIN encodes b_encode ON b_encode.encode_id = b.encode_id_b
WHERE b.bond_type = 'contradictory'
ORDER BY b.strength DESC;
```

---

## JSON Schema Examples

### participants (traces)

```json
["jp", "swiv", "forge"]
```

### source_trace_ids (encodes)

```json
["550e8400-e29b-41d4-a716-446655440000"]
```

### emotional_tags (encodes)

```json
["frustration", "breakthrough", "clarity"]
```

### topics (encodes)

```json
["RECALL", "schema", "architecture", "sqlite"]
```

### entities (encodes)

```json
{
  "people": ["JP"],
  "projects": ["RECALL", "Prism"],
  "tools": ["sqlite-vec", "OpenAI"],
  "organizations": ["Swivel Labs"]
}
```

---

## Migration History

### v0.1 → v0.3

Added:
- `traces.significance` column (INTEGER, 1-10)
- `encodes.memory_type` column (TEXT, enum)
- `bonds` table (new)
- Associated indexes

Migration logic:
```sql
-- Existing traces: identity → 9, others → 5
UPDATE traces SET significance = CASE 
  WHEN is_identity_trace = 1 THEN 9
  ELSE 5
END;

-- Existing encodes: default to episodic
UPDATE encodes SET memory_type = 'episodic' WHERE memory_type IS NULL;
```

Run via: `recall migrate`

---

## Size Estimates

| Component | Per-Record | Notes |
|-----------|-----------|-------|
| Trace (raw) | ~2KB | Varies by content length |
| Encode | ~8KB | Includes 1536-dim embedding (6KB) |
| Bond | ~200 bytes | Small metadata record |
| Typical session | 10-50KB | 3-5 traces + encodes |

**Production example:**
- 1,684 encodes
- ~14MB total database
- Query times consistently <100ms
