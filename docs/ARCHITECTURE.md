# RECALL Architecture — Technical Deep Dive

This document is for developers who want to understand how RECALL works under the hood. Design decisions, schema details, cognitive science foundations, and migration strategies.

---

## Design Philosophy

**Agents don't need better knowledge. They need to have *lived*.**

Most memory systems treat agents as search engines with context. RECALL treats them as entities with continuity — past experiences shape present behavior. This requires:

1. **Typed memories** — Different memory types behave differently
2. **Forgetting** — Not all memories deserve equal weight forever
3. **Relationships** — Memories connect; context comes from clusters
4. **Contradictions** — Agents should know when they learned something conflicting

---

## Cognitive Science Foundations

### The 4 Memory Types (CoALA Framework)

RECALL implements the memory typology from [CoALA: Cognitive Architectures for Language Agents](https://arxiv.org/abs/2309.02427):

- **Episodic**: Event memories — what happened, when, with whom
- **Semantic**: Factual knowledge — concepts, definitions, relationships  
- **Procedural**: Skill memories — how to do things, patterns, workflows
- **Self-model**: Identity — values, beliefs, goals, "who I am"

Each type has distinct characteristics:
- Retrieval patterns differ
- Decay rates differ
- Sharing boundaries differ (self-model is private)

### Importance Scoring (Generative Agents)

The significance scoring (1-10) and importance extraction draw from [Generative Agents: Interactive Simulacra of Human Behavior](https://arxiv.org/abs/2304.03442) by Stanford:

> "The agent perceives its environment and... forms observations. These are passed to the natural language model, which... outputs a salience score..."

RECALL implements this as explicit `significance` and `importance_score` fields, computed during encode.

### Decay Rates (Biological Memory)

Decay rates are derived from research on human forgetting curves:

- **Episodic**: 7%/day — Ebbinghaus forgetting curve for events
- **Semantic**: 2%/day — Semantic knowledge persists longer (Craik & Lockhart, 1972)
- **Procedural**: 3%/day — Skills fade slower than events but faster than facts
- **Self-model**: 1%/day — Core identity is most stable

These rates are tunable via code modification. The principle (different rates per type) is fixed.

### Molecular Memory (Mole-Syn)

The bond system draws from ByteDance's [Mole-Syn: Mapping the Topology of Long Chain-of-Thought Reasoning](https://arxiv.org/abs/2601.06002):

> "Memories are not isolated entities but form a molecular structure through causal, temporal, and semantic bonds."

RECALL implements four bond types:
- **Causal**: A caused B (A happens → B happens, causal language present)
- **Temporal**: A and B co-occurred (same session or <1 hour apart)
- **Semantic**: A and B are about similar things (embedding similarity >0.8)
- **Contradictory**: A and B conflict (similarity + opposite sentiment)

---

## System Architecture

### Layer Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        AGENT SESSION                        │
└─────────────────────────┬───────────────────────────────────┘
                          │ captureTrace()
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  TRACE LAYER — Raw captures (immutable)                     │
│  • Content, participants, timestamps                        │
│  • Significance score (1-10)                                │
│  • Encode status tracking                                   │
└─────────────────────────┬───────────────────────────────────┘
                          │ runEncodePipeline()
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  ENCODE LAYER — Structured memories                         │
│  • Semantic summary + embedding                             │
│  • Memory type classification                               │
│  • Emotional valence + importance score                     │
│  • Topics, entities, compression ratio                      │
└─────────────────────────┬───────────────────────────────────┘
                          │ createMemoryBonds()
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  BOND LAYER — Molecular connections                         │
│  • Causal, semantic, temporal, contradictory                │
│  • Strength scores (0-1)                                    │
│  • Max 10 bonds per encode (sparse graph)                   │
└─────────────────────────┬───────────────────────────────────┘
                          │ semanticSearchWithDecay() / getEncodesForBoot()
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  RECALL LAYER — Context retrieval                           │
│  • Decay-adjusted scoring                                   │
│  • Bond traversal for clusters                              │
│  • Prioritized by type + significance                       │
└─────────────────────────────────────────────────────────────┘
```

---

## Database Schema (SQLite)

### traces — Raw Captures

```sql
CREATE TABLE traces (
  trace_id TEXT PRIMARY KEY,           -- UUID v4
  agent_id TEXT NOT NULL,              -- Agent that experienced this
  session_id TEXT NOT NULL,            -- Session identifier
  session_seq INTEGER NOT NULL,        -- Order within session (1-indexed)
  timestamp_start TEXT NOT NULL,       -- ISO 8601
  timestamp_end TEXT NOT NULL,         -- ISO 8601
  content_raw TEXT NOT NULL,           -- Raw content
  content_hash TEXT NOT NULL,          -- SHA-256 for dedup
  participants TEXT NOT NULL,          -- JSON array
  channel TEXT NOT NULL,               -- Surface (discord, terminal, etc.)
  trace_type TEXT NOT NULL CHECK(trace_type IN (
    'conversation', 'decision', 'task_completion', 'error', 'handoff'
  )),
  is_identity_trace INTEGER NOT NULL DEFAULT 0,
  significance INTEGER DEFAULT 5       -- 1-10 (v0.3+)
    CHECK(significance >= 1 AND significance <= 10),
  encode_status TEXT NOT NULL DEFAULT 'pending'
    CHECK(encode_status IN ('pending', 'encoded', 'skipped')),
  created_at TEXT NOT NULL             -- ISO 8601
);
```

**Indexes:**
```sql
CREATE INDEX idx_traces_agent_session ON traces(agent_id, session_id);
CREATE INDEX idx_traces_encode_status ON traces(encode_status) WHERE encode_status = 'pending';
CREATE INDEX idx_traces_significance ON traces(significance);
```

### encodes — Structured Memories

```sql
CREATE TABLE encodes (
  encode_id TEXT PRIMARY KEY,          -- UUID v4
  agent_id TEXT NOT NULL,              -- Owning agent
  source_trace_ids TEXT NOT NULL,      -- JSON array of trace IDs
  session_id TEXT NOT NULL,            -- Denormalized for fast queries
  timestamp_encoded TEXT NOT NULL,     -- ISO 8601
  semantic_summary TEXT NOT NULL,      -- 1-3 sentence summary
  semantic_embedding BLOB NOT NULL,    -- Binary embedding vector
  embedding_model TEXT NOT NULL,       -- e.g., text-embedding-3-small
  emotional_valence REAL NOT NULL,     -- -1.0 to 1.0
  emotional_tags TEXT,                 -- JSON array (optional)
  importance_score REAL NOT NULL,      -- 0.0 to 1.0
  importance_reason TEXT,              -- Why this score
  topics TEXT NOT NULL,                -- JSON array
  entities TEXT,                       -- JSON object (optional)
  compression_ratio REAL NOT NULL,     -- len(raw) / len(summary)
  memory_type TEXT DEFAULT 'episodic'  -- (v0.3+)
    CHECK(memory_type IN ('episodic', 'semantic', 'procedural', 'self_model')),
  consolidation_status TEXT NOT NULL DEFAULT 'pending'
    CHECK(consolidation_status IN ('pending', 'consolidated', 'pruned')),
  is_shared INTEGER NOT NULL DEFAULT 0, -- Cross-agent readable?
  created_at TEXT NOT NULL             -- ISO 8601
);
```

**Virtual table for vector search:**
```sql
CREATE VIRTUAL TABLE vec_encodes USING vec0(
  encode_id TEXT PRIMARY KEY,
  embedding FLOAT[1536]
);
```

**Indexes:**
```sql
CREATE INDEX idx_encodes_consolidation ON encodes(consolidation_status) 
  WHERE consolidation_status = 'pending';
CREATE INDEX idx_encodes_agent ON encodes(agent_id);
CREATE INDEX idx_encodes_memory_type ON encodes(memory_type);
CREATE INDEX idx_encodes_shared ON encodes(is_shared) WHERE is_shared = 1;
```

### bonds — Molecular Connections

```sql
CREATE TABLE bonds (
  bond_id TEXT PRIMARY KEY,            -- composite: encode_a + encode_b + type
  encode_id_a TEXT NOT NULL,           -- First encode (ordered)
  encode_id_b TEXT NOT NULL,           -- Second encode
  bond_type TEXT NOT NULL CHECK(bond_type IN (
    'causal', 'semantic', 'temporal', 'contradictory'
  )),
  strength REAL NOT NULL               -- 0.0 to 1.0
    CHECK(strength >= 0 AND strength <= 1),
  created_at TEXT NOT NULL             -- ISO 8601
);
```

**Indexes:**
```sql
CREATE INDEX idx_bonds_encode_a ON bonds(encode_id_a);
CREATE INDEX idx_bonds_encode_b ON bonds(encode_id_b);
CREATE INDEX idx_bonds_type ON bonds(bond_type);
```

---

## The Encode Pipeline

The encode pipeline transforms raw traces into structured memories. Here's the full flow:

### 1. Significance Calculation (Rule-Based)

```typescript
function calculateSignificance(trace: Trace): number {
  let significance = 5;  // Default
  
  // Trace type base score
  if (trace.is_identity_trace) significance = 9;
  else switch (trace.trace_type) {
    case 'decision': significance = 7; break;
    case 'error': significance = 7; break;
    // ... etc
  }
  
  // Keyword boost
  if (content.includes('breakthrough')) significance = Math.max(significance, 9);
  // ... etc
  
  return clamp(significance, 1, 10);
}
```

### 2. Importance Scoring

```typescript
const baseImportance = TYPE_IMPORTANCE[trace.trace_type] ?? 0.3;
const importanceScore = Math.min(1.0, baseImportance * (significance / 5));
```

### 3. Semantic Summary (LLM)

```typescript
const response = await openai.chat.completions.create({
  model: config.llmModel,  // gpt-4o-mini default
  messages: [
    {
      role: 'system',
      content: 'Summarize in 1-3 sentences. Focus on what happened, key decisions, outcomes.'
    },
    { role: 'user', content: trace.content_raw }
  ],
  temperature: 0.3,
  max_tokens: 150
});
```

### 4. Embedding Generation

```typescript
const response = await openai.embeddings.create({
  model: config.embeddingModel,  // text-embedding-3-small default
  input: semanticSummary
});
// Returns 1536-dim vector
```

### 5. Memory Type Classification (Rule-Based)

```typescript
function classifyMemoryType(trace: Trace, summary: string): MemoryType {
  if (trace.is_identity_trace) return 'self_model';
  
  const content = (trace.content_raw + ' ' + summary).toLowerCase();
  
  // Check indicators in priority order
  if (hasIndicator(content, MEMORY_TYPE_INDICATORS.self_model)) return 'self_model';
  if (hasIndicator(content, MEMORY_TYPE_INDICATORS.semantic)) return 'semantic';
  if (hasIndicator(content, MEMORY_TYPE_INDICATORS.procedural)) return 'procedural';
  
  return 'episodic';  // Default
}
```

### 6. Emotional Analysis (LLM)

```typescript
const response = await openai.chat.completions.create({
  messages: [{
    role: 'system',
    content: `Analyze emotional tone. Return JSON with:
      - valence: number (-1.0 to 1.0)
      - tags: string[] (0-3 labels like "frustration", "breakthrough")`
  }],
  response_format: { type: 'json_object' }
});
```

### 7. Topic/Entity Extraction (LLM)

```typescript
const response = await openai.chat.completions.create({
  messages: [{
    role: 'system',
    content: `Extract topics and entities. Return JSON with:
      - topics: string[] (3-7 key topics)
      - entities: object with keys: people, projects, tools, organizations`
  }],
  response_format: { type: 'json_object' }
});
```

### 8. Bond Creation

After storing the encode, find similar memories and create bonds:

```typescript
// Find similar encodes (embedding similarity > 0.8)
const similar = findSimilarEncodes(embedding, 0.8, newEncodeId);

for (const { encode, similarity } of similar.slice(0, 10)) {
  const bondType = detectBondType(trace, summary, encode, similarity);
  const strength = calculateBondStrength(similarity, bondType, trace, encode);
  
  createBond({
    encode_id_a: newEncodeId,
    encode_id_b: encode.encode_id,
    bond_type: bondType,
    strength
  });
}
```

**Bond type detection:**
```typescript
function detectBondType(trace, summary, similarEncode, similarity): BondType {
  // Check for contradiction markers + high similarity
  if (hasContradictionMarkers && similarity > 0.85) return 'contradictory';
  
  // Check for causal language + temporal proximity (<1hr)
  if (hasCausalMarkers && hoursDiff <= 1) return 'causal';
  
  // Check for same session or close time
  if (sameSession || hoursDiff <= 1) return 'temporal';
  
  // Default: semantic similarity
  return 'semantic';
}
```

---

## Decay-Adjusted Recall

When querying memories, RECALL applies biological decay:

```typescript
const decayRate = DECAY_RATES[encode.memory_type];  // e.g., 0.07 for episodic
const daysOld = (now - encodeDate) / (1000 * 60 * 60 * 24);
const decayedScore = rawScore * Math.pow(1 - decayRate, daysOld);
```

High-significance memories decay slower:
```typescript
function getDecayModifier(significance: number): number {
  if (significance >= 9) return 0.5;   // Half decay
  if (significance >= 7) return 0.7;   // Reduced decay
  if (significance >= 4) return 1.0;   // Normal
  return 1.3;                           // Accelerated decay
}
```

---

## Boot Context Retrieval

When an agent starts up, `recall boot` retrieves the most relevant context:

```typescript
function getEncodesForBoot(agentId: string, limit: number, includeBonds: boolean) {
  // Priority order:
  // 1. Memory type (self_model > semantic > procedural > episodic)
  // 2. Significance score
  // 3. Importance score
  // 4. Recency
  
  const stmt = db.prepare(`
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
    LIMIT ?
  `);
  
  // If includeBonds: traverse bonds to get related memories
  // Returns memory clusters, not isolated memories
}
```

---

## Migration Strategy

RECALL includes automatic migrations. When you upgrade versions:

```bash
recall migrate
```

### v0.1 → v0.3 Migration Steps

1. **Add significance column to traces:**
   - Default: 5
   - Existing identity traces → 9
   - Others → 5

2. **Add memory_type column to encodes:**
   - Default: 'episodic'
   - Existing encodes reclassified on next encode run

3. **Create bonds table:**
   - New table with indexes
   - Populated on new encodes (not backfilled)

All migrations are idempotent and safe to run multiple times.

---

## Performance Characteristics

### Query Performance (Production)

```
Boot context retrieval:     51ms  (5 memories + bond traversal)
Semantic search (no decay): 45ms  (top-k vector search)
Semantic search (decay):    87ms  (vector search + decay calculation)
Encode pipeline:           ~600ms/trace  (with LLM calls)
Bond creation:            ~200ms/trace  (piggybacks on embedding)
```

### Storage Characteristics

```
Per-trace overhead:        ~2KB (raw content)
Per-encode overhead:       ~8KB (summary, embedding, metadata)
Per-bond overhead:         ~200 bytes

Fleet total (4 agents, months):
  - 1,684 encodes
  - ~14MB database
  - Query times: <100ms
```

### Scaling Limits

SQLite practical limits (per-agent):
- 1M+ memories: fine
- 10M+ memories: consider VACUUM, index optimization
- 100M+ memories: shard by agent or time

You'll hit context window limits first.

---

## Security & Privacy

### Data Ownership

- SQLite file on local disk
- No cloud service required (except OpenAI for embeddings)
- You own your agent's memories

### Sharing Boundaries

- `is_shared` field controls cross-agent access
- `self_model` memories are never shared
- Identity traces are never shared
- Sharing is default-off for conversations

### Contradiction Warnings

When a contradiction is detected, it's logged but not auto-resolved:

```
⚠️  CONTRADICTION DETECTED
   New memory: User wants to use Redis for caching...
   Similar memory: User decided against Redis due to...
   Flagged for human review.
```

Human judgment required. The system surfaces conflicts, doesn't resolve them.

---

## Future Directions

Not implemented yet, but designed for:

- **Consolidation layer** — Merge related memories over time
- **Integration layer** — Write to SOUL.md/MEMORY.md staging
- **Cross-agent query** — Read shared episodic layer
- **Multi-modal** — Images, audio, not just text

The v0.3 schema supports these. The pipeline is designed to extend.

---

## References

1. **CoALA**: Wang et al. "Cognitive Architectures for Language Agents." 2023.
2. **Generative Agents**: Park et al. "Generative Agents: Interactive Simulacra of Human Behavior." 2023.
3. **Mole-Syn**: Wang et al. "Mapping the Topology of Long Chain-of-Thought Reasoning." ByteDance Research, 2025. arxiv:2601.06002
4. **Ebbinghaus**: Ebbinghaus, H. "Memory: A Contribution to Experimental Psychology." 1885.
5. **Levels of Processing**: Craik & Lockhart. "Levels of Processing: A Framework for Memory Research." 1972.
