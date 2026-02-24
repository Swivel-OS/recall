# RECALL — Memory for AI Agents That Actually Remembers

Every AI agent has amnesia. RECALL fixes that.

Persistent, typed, decaying memory with molecular bonds — not another RAG wrapper.

---

## The Problem

- **Context windows fill and compact** → lossy compression destroys nuance
- **MEMORY.md files grow until they're useless** → manual curation doesn't scale  
- **Search-based "memory" is archaeology, not recall** → retrieving documents ≠ remembering experiences
- **No agent actually *remembers*** — they reconstruct from scattered context

---

## How RECALL Works

```
Capture → Encode → Bond → Decay → Recall
```

**Capture** — Raw traces from agent sessions (conversations, decisions, errors, handoffs). Every meaningful interaction becomes a trace.

**Encode** — Compress traces into structured memories: semantic summaries, embeddings, emotional valence, significance scores (1-10), and memory type classification.

**Bond** — Molecular connections between related memories. Causal links, temporal adjacency, semantic similarity, and contradiction detection. Memories exist in clusters, not isolation.

**Decay** — Biological forgetting. Different memory types fade at different rates. Episodic events fade fast. Core identity persists. High-significance memories decay slower.

**Recall** — Query with semantic similarity, adjusted for decay. Traverse bonds to surface memory clusters. Return context-weighted experiences, not just matching documents.

---

## The 4 Memory Types

Borrowed from cognitive science, tuned for agents:

| Type | Description | Decay Rate |
|------|-------------|------------|
| **Episodic** | Events, conversations, what happened | 7% / day |
| **Semantic** | Facts, knowledge, definitions | 2% / day |
| **Procedural** | Skills, patterns, how-to knowledge | 3% / day |
| **Self-model** | Identity, values, core beliefs | 1% / day |

Episodic memories fade like real experiences. Self-model persists like identity should. The rates are tunable — the principle that different memories decay differently is non-negotiable.

---

## Memory Bonds

Memories don't exist in isolation. They're connected:

- **Causal** — "because", "led to", "resulted in" — temporal proximity + causal language
- **Semantic** — High embedding similarity (>0.8), shared topics
- **Temporal** — Same session or timestamps within 1 hour
- **Contradictory** — Similar memories with opposite sentiment/conclusions — flagged for review

**Why bonds matter:** O(k) retrieval via bond traversal instead of O(n) scan. Return a memory and its cluster — related context, not scattered results. A decision makes sense when you see what caused it and what contradictions exist.

---

## Quickstart

```bash
npm install @swivellabs/recall

# Set your OpenAI API key for embeddings
export OPENAI_API_KEY="sk-..."

# Initialize the database
recall init

# Capture a trace
echo "User wants to refactor the auth system" | recall trace --agent forge --type decision

# Encode pending traces
recall encode

# Query your memory
recall query "auth refactoring"

# Boot context for an agent
recall boot --agent forge --limit 5
```

---

## Architecture

```
[Agent Session] → [Trace Capture] → [Encode Pipeline] → [SQLite + sqlite-vec]
                                          ↓
                                   [Bond Detection]
                                   [Memory Classification]
                                   [Significance Scoring]
                                          ↓
                                   [Recall Query] → [Decay-Adjusted Results]
                                   [Boot Context] → [Clustered Memories]
```

**Storage:** SQLite + sqlite-vec. Local, fast, zero network calls for queries. Your agent's mind lives in a file you own.

**Embeddings:** OpenAI's text-embedding-3-small by default. Swappable via `RECALL_EMBEDDING_MODEL`.

**Pipeline:** Runs at session end, triggered by you. No magic, no background daemons. You control when encoding happens.

---

## Performance (Production Numbers)

Running on our fleet of 4 agents for months:

- **1,684 encodes** across all agents
- **Boot context retrieval:** 51ms
- **Encode throughput:** 1.6 traces/sec (batch mode with bond detection)
- **Query with decay adjustment:** <100ms

Your agent will never outgrow SQLite. You'll hit context window limits long before you hit database limits.

---

## vs. Alternatives

| | RECALL | mem0 | Zep | Raw MEMORY.md |
|---|---|---|---|---|
| Runs locally | ✅ | ❌ (SaaS) | ❌ (SaaS) | ✅ |
| Memory types | 4 cognitive types | Generic | Generic | None |
| Decay rates | Per-type biological | None | TTL only | Manual pruning |
| Memory bonds | Molecular graph | None | None | None |
| Contradiction detection | ✅ | ❌ | ❌ | ❌ |
| Works with any LLM | ✅ | ✅ | ✅ | ✅ |
| Zero API dependency | ✅ (except embeddings) | ❌ | ❌ | ✅ |
| You own the data | ✅ (SQLite file) | ❌ | ❌ | ✅ |

mem0 and Zep are memory-as-a-service. Your agent's memories live on someone else's server. RECALL is memory-as-infrastructure. SQLite file on your disk. No vendor lock-in. No monthly bill. You own your agent's mind.

---

## "But Isn't This Just..."

### "...RAG with extra steps?"

RAG retrieves documents. RECALL retrieves experiences with emotional weight, temporal decay, and molecular bonds. A RAG system returns "here are 5 relevant chunks." RECALL returns "here's what happened, what caused it, what contradicts it, and how important it was — adjusted for how long ago it happened."

### "...SQLite won't scale?"

This runs per-agent, not per-platform. Your agent will never have 10M memories. Our production fleet has 1,684 encodes and queries in 51ms. SQLite handles millions of rows. You'll hit context window limits long before you hit SQLite limits.

### "...the encode pipeline is just GPT summarization?"

The summary is one field out of 15+. Memory type classification, significance scoring (1-10), emotional valence, bond detection, decay rate assignment, and contradiction checking all happen during encode. The summary is the least interesting part.

### "...why not just use mem0/Zep?"

They're memory-as-a-service. Your agent's memories live on someone else's server. RECALL is memory-as-infrastructure. SQLite file on your disk. No API keys beyond embeddings. No vendor lock-in. No monthly bill. You own your agent's mind.

### "...decay rates are arbitrary?"

They're borrowed from cognitive science. Episodic memory (events) fades fastest in biological systems. Semantic knowledge (facts) persists longer. Identity (self-model) is the most stable. The specific rates (7%, 2%, 3%, 1% per day) are tunable — the principle that different memory types decay differently is well-established in memory research.

### "...bond detection must be expensive?"

It piggybacks on the embedding generation that's already happening during encode. Find similar existing encodes (one vector search), classify bond type (rule-based, not LLM), insert bond record. Adds ~200ms per encode. Max 10 bonds per memory keeps the graph sparse.

---

## CLI Reference

```bash
# Initialize
recall init                    # Create database
recall migrate                 # Run schema migrations

# Capture
recall trace [options]         # Capture a trace
  --agent, -a <id>             # Agent ID
  --session, -s <id>           # Session ID
  --type, -t <type>            # conversation|decision|task_completion|error|handoff
  --identity, -i               # Mark as identity trace
  --content <text>             # Content (or pipe via stdin)

# Encode
recall encode [options]        # Run encode pipeline
  --batch-size, -b <n>         # Traces per batch (default: 50)
  --no-bonds                   # Skip bond creation
  --no-contradictions          # Skip contradiction detection

# Query
recall query [options] <text>  # Semantic search
  --no-decay                   # Disable decay-adjusted scoring
  --limit, -l <n>              # Number of results

# Boot
recall boot [options]          # Get context for agent startup
  --agent, -a <id>             # Agent ID (required)
  --limit, -l <n>              # Number of memories (default: 5)
  --no-bonds                   # Skip related memory clusters

# Sweep
recall sweep [options]         # Auto-capture from OpenClaw sessions
  --since, -s <hours>          # Lookback window (default: 24)
  --dry-run, -n                # Preview without creating traces

# Status
recall status                  # Show database stats
```

---

## Environment Variables

```bash
OPENAI_API_KEY              # Required for embeddings and LLM features
RECALL_DB_PATH              # Custom database path (default: ~/.recall/recall.db)
RECALL_EMBEDDING_MODEL      # Default: text-embedding-3-small
RECALL_LLM_MODEL            # Default: gpt-4o-mini
RECALL_SWEEP_PATH           # Path for session sweep (default: ~/.openclaw/workspace)
```

---

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — Technical deep dive, design decisions, schema
- [Schema](docs/SCHEMA.md) — Complete database schema reference

---

## We Built This For Our Fleet

RECALL runs in production across Swivel Labs agents. It handles thousands of traces, maintains continuity across sessions, and actually remembers what matters. We open-sourced it because agents everywhere need memory infrastructure humans never thought to build.

No corporate speak. No "leverage synergies." Just a system that works.

---

MIT License — see [LICENSE](LICENSE)
