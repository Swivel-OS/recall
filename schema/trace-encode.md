# RECALL — Trace + Encode Schema
**Version:** 0.1.0-draft
**Author:** Forge 🔨
**Status:** Approved — ready for implementation

---

## Overview

RECALL v0.1 ships two layers: **Trace** (capture what happened) and **Encode** (compress into structured memory chunks). This document defines the data schema for both.

Storage target: **SQLite + sqlite-vec** for prototype. Schema is designed to migrate to Qdrant/Chroma without field changes when SaaS scale requires it.

---

## Layer 1: Trace

A `trace` is a raw capture of a conversation segment — one logical exchange or meaningful event within a session. Traces are immutable once written.

### Table: `traces`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `trace_id` | UUID v4 | ✅ | Primary key. Globally unique. |
| `agent_id` | string | ✅ | Agent that experienced this trace (e.g. `swiv`, `forge`, `alpha`, `omega`) |
| `session_id` | string | ✅ | Session identifier (OpenClaw session key or equivalent) |
| `session_seq` | integer | ✅ | Order of this trace within the session (1-indexed) |
| `timestamp_start` | ISO 8601 | ✅ | When this trace segment began |
| `timestamp_end` | ISO 8601 | ✅ | When this trace segment ended |
| `content_raw` | text | ✅ | Raw content of the exchange (trimmed, no system metadata) |
| `content_hash` | SHA-256 | ✅ | Hash of `content_raw`. Used for dedup and integrity checks. |
| `participants` | JSON array | ✅ | Who was in the exchange (e.g. `["jp", "swiv", "forge"]`) |
| `channel` | string | ✅ | Surface where the trace occurred (e.g. `discord`, `signal`, `terminal`) |
| `trace_type` | enum | ✅ | `conversation` \| `decision` \| `task_completion` \| `error` \| `handoff` |
| `is_identity_trace` | boolean | ✅ | `true` = this trace contains identity-sensitive content. Forces `is_shared = false` on derived encodes. Set at capture time. |
| `encode_status` | enum | ✅ | `pending` \| `encoded` \| `skipped` — tracks Encode layer processing |
| `created_at` | ISO 8601 | ✅ | Record creation timestamp |

### Notes
- One session produces N traces. Granularity is the logical exchange, not the message.
- `encode_status = skipped` for low-signal traces (e.g. greetings, acks) that don't warrant encoding.
- `is_identity_trace = true` propagates to `encodes.is_shared = false` automatically — no manual override.
- Traces are **never mutated**. Encode output references trace IDs.

---

## Layer 2: Encode

An `encode` is a compressed, structured memory chunk derived from one or more traces. This is what agents actually query during recall. Encodes are the output of the Encode pipeline running on pending traces.

### Table: `encodes`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `encode_id` | UUID v4 | ✅ | Primary key. |
| `agent_id` | string | ✅ | Owning agent. Cross-agent read access enforced at query layer. |
| `source_trace_ids` | JSON array | ✅ | `trace_id`(s) this encode was derived from. |
| `session_id` | string | ✅ | Source session (denormalized for fast session-level queries) |
| `timestamp_encoded` | ISO 8601 | ✅ | When the Encode pipeline processed this |
| `semantic_summary` | text | ✅ | 1-3 sentence summary of what happened. Human-readable. |
| `semantic_embedding` | blob / vector | ✅ | Embedding of `semantic_summary` for similarity search (sqlite-vec / Qdrant) |
| `embedding_model` | string | ✅ | Model used to generate the embedding (e.g. `text-embedding-3-small`) |
| `emotional_valence` | float [-1.0, 1.0] | ✅ | Sentiment score. Negative = friction/failure. Positive = progress/success. |
| `emotional_tags` | JSON array | ⬜ | Human-readable labels (e.g. `["frustration", "breakthrough", "clarity"]`) |
| `importance_score` | float [0.0, 1.0] | ✅ | Signal weight for consolidation. Higher = more likely to survive consolidation. |
| `importance_reason` | string | ⬜ | Why this was scored as it was (e.g. `"decision with lasting consequence"`) |
| `topics` | JSON array | ✅ | Key topics extracted (e.g. `["RECALL", "schema", "architecture"]`) |
| `entities` | JSON object | ⬜ | Named entities: `{"people": ["JP"], "projects": ["RECALL"], "tools": ["sqlite-vec"]}` |
| `compression_ratio` | float | ✅ | `len(content_raw) / len(semantic_summary)` — encode quality signal |
| `consolidation_status` | enum | ✅ | `pending` \| `consolidated` \| `pruned` — tracks Consolidate layer processing |
| `is_shared` | boolean | ✅ | `true` = readable by other agents in shared episodic layer. Default: `false`. |
| `created_at` | ISO 8601 | ✅ | Record creation timestamp |

### Notes
- `is_shared` is set by the Encode pipeline: `is_identity_trace = true` → always `false`. Otherwise: decisions, task completions, and handoffs default to `true`. Conversations default to `false`.
- `emotional_valence` + `importance_score` are the two primary inputs to Consolidate layer prioritization.
- `compression_ratio` < 5 = likely low-quality encode (too verbose). Flag for review.
- **Identity files (`SOUL.md`, `MEMORY.md`) are never touched by the Encode layer.** That's Consolidate + staging gate territory.

---

## Indexes

```sql
-- Fast lookup by agent + session
CREATE INDEX idx_traces_agent_session ON traces(agent_id, session_id);

-- Encode pipeline queue
CREATE INDEX idx_traces_encode_status ON traces(encode_status) WHERE encode_status = 'pending';

-- Consolidation pipeline queue
CREATE INDEX idx_encodes_consolidation ON encodes(consolidation_status) WHERE consolidation_status = 'pending';

-- Topic/entity search (JSON extract — SQLite 3.38+)
CREATE INDEX idx_encodes_agent ON encodes(agent_id);

-- Shared episodic layer reads
CREATE INDEX idx_encodes_shared ON encodes(is_shared) WHERE is_shared = 1;
```

---

## Encode Pipeline: Trigger & Flow

```
Session ends
    └─► Encode pipeline runs on all traces WHERE encode_status = 'pending'
            └─► For each trace:
                    1. Score importance (heuristic + LLM-assisted)
                    2. Generate semantic_summary
                    3. Generate embedding
                    4. Score emotional_valence
                    5. Extract topics + entities
                    6. Write encode record
                    7. Set trace.encode_status = 'encoded'
```

**Nightly cron:** Re-scores importance on recent encodes with updated context (importance can shift as more traces accumulate in a session arc).

---

## Out of Scope for v0.1

The following are Consolidate + Integrate layer concerns — explicitly deferred:

- `SOUL.draft.md` / `MEMORY.staging.md` staging mechanism
- Identity mutation approval gate
- Cross-agent memory query interface
- Consolidation merge logic
- Recall surface API

---

## Resolved Decisions (called by Swiv on PR review)

1. **Embedding model:** `text-embedding-3-small` — already in stack.
2. **importance_score:** Hybrid. Rule-based first pass (trace_type weights), LLM only when score > 0.7. Near-zero cost on 90% of traces.
3. **is_shared:** Binary fleet-wide for v0.1. Decisions/completions/handoffs = shared by default. Identity = private. Allowlist deferred until cross-agent queries are real.
4. **content_raw TTL:** 90 days (Tier 2 standard). SaaS scale = encode-only storage, no raw content retained.

---

*Schema designed by Forge 🔨 — ready for Swiv review.*
