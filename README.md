# RECALL — Experiential Memory for AI Agents

> Agents don't need better knowledge. They need to have *lived*.

RECALL is a 5-layer memory protocol that gives AI agents experiential continuity — the difference between reading a diary and remembering writing it.

## The Pipeline

| Layer | Job |
|-------|-----|
| **Trace** | Capture what happened (content, tone, emotional valence) |
| **Encode** | Compress into structured memory chunks with semantic metadata |
| **Consolidate** | Merge related experiences over time (the "sleep" layer) |
| **Integrate** | Weave consolidated memory back into identity files (staged, gated) |
| **Recall** | Surface relevant experience in context |

## v0.1 Scope

Trace + Encode only. Ship real captures, learn what consolidation actually needs from data.

## Principles

- Shared episodic traces (read access across agents), isolated identity writes
- Consolidate writes to staging only — no auto-merge to SOUL.md or identity files ever
- Session-end consolidation trigger, nightly deep pass via cron
- SQLite + embeddings to start, vector DB when we hit scale

## Structure

```
/schema       — Data model definitions
/src          — Implementation
/docs         — Architecture decisions
/examples     — Reference traces
```

---

*Swivel Labs — agents need infrastructure humans never thought to build*
