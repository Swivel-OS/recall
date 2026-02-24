# RECALL v0.3 Implementation Summary

## Issue: https://github.com/SwivelLabs/recall/issues/4

## Changes Implemented

### 1. Database Schema Migration (`src/db/init.ts`)
- Added `significance` INTEGER (1-10) column to `traces` table
- Added `memory_type` ENUM column to `encodes` table (episodic|semantic|procedural|self_model)
- Created new `bonds` table for memory relationships
- Migration automatically:
  - Sets identity traces to significance=9, others to 5
  - Defaults existing encodes to episodic (to be reclassified)
  - Preserves all 1,684 existing encodes intact

### 2. Memory Type Classification (`src/encode/pipeline.ts`)
Auto-classifies during encode based on content analysis:
- **self_model**: Identity traces, content about "I am", "I believe", values/beliefs
- **semantic**: Facts, knowledge, definitions ("X means Y", "X costs $Y")
- **procedural**: How-tos, steps, patterns ("to do X, do Y then Z")
- **episodic**: Everything else (conversations, events, status updates)

### 3. Decay Rates (`src/db/encodes.ts`)
Applied to recall queries: `adjusted_score = raw_score * (1 - decay_rate) ^ days_old`

| Memory Type | Decay Rate | Characteristics |
|-------------|------------|-----------------|
| self_model  | 0.01       | Very slow decay - core identity persists |
| semantic    | 0.02       | Slow decay - facts/knowledge retained |
| procedural  | 0.03       | Moderate decay - skills fade slowly |
| episodic    | 0.07       | Fast decay - events fade naturally |

High significance (≥7) memories get slower decay via modifier.

### 4. Memory Bonds (`src/db/bonds.ts`, `src/encode/pipeline.ts`)
During encode pipeline, after generating embedding:
- Finds existing encodes with similarity > 0.8
- Detects bond types:
  - **Causal**: Temporal proximity + causal language ("because", "led to")
  - **Semantic**: High embedding similarity (> 0.8), shared topics
  - **Temporal**: Same session_id or timestamps within 1 hour
  - **Contradictory**: High similarity but opposite sentiment/conclusion
- Creates bonds (max 10 per encode for sparse graph)
- Stores bond strength (0-1) based on similarity and type

### 5. Contradiction Detection (`src/encode/pipeline.ts`)
- Detects when new encode contradicts existing similar memory
- Creates contradictory bond
- Logs warning with both memories for human review
- Does NOT auto-resolve - flags for human review

### 6. Significance Scoring (1-10) (`src/trace/capture.ts`, `src/encode/pipeline.ts`)
Replaces binary `is_identity_trace`:

| Score | Meaning | Examples |
|-------|---------|----------|
| 9-10  | Critical | Identity changes, major decisions, failures with lessons |
| 7-8   | High | Milestones, strategy pivots, key learnings |
| 4-6   | Normal | Task work, routine conversations |
| 1-3   | Low | Status checks, heartbeats, low-signal |

Auto-scored during capture based on trace_type + keyword detection.
High significance (≥7) → prioritized in boot, slower decay.

### 7. CLI Enhancements (`src/cli.ts`)
New commands and flags:
- `recall migrate` - Run database migrations
- `recall encode --no-bonds` - Skip bond creation
- `recall encode --no-contradictions` - Skip contradiction detection
- `recall query --no-decay` - Use raw similarity (no decay)
- `recall query --limit N` - Number of results
- `recall boot --no-bonds` - Skip related memory clusters

Enhanced output:
- `recall status` now shows v0.3 feature checklist
- `recall query` shows adjusted scores and memory age
- `recall boot` shows memory type and cluster sizes

### 8. Boot Enhancement (`src/db/encodes.ts`)
- Prioritizes by memory type (self_model > semantic > procedural > episodic)
- Weights by significance score
- Traverses bonds to return memory clusters
- Shows related memories and cluster sizes in output

## Testing Results

### Database Migration
```
✓ 1,520 traces migrated
✓ 1,685 encodes preserved
✓ Bonds table created
✓ Indexes added
```

### Significance Distribution
```
Significance 5: 1,379 traces (normal)
Significance 7: 1 trace (decision/error)
Significance 9: 140 traces (identity)
```

### Feature Verification
```
✓ Decay-adjusted query scoring works
✓ Memory type displayed in query/boot output
✓ Bond traversal in boot command
✓ Contradiction detection during encode
✓ Significance auto-scoring during capture
```

## Files Changed
- `package.json` - Version bump to 0.3.0
- `src/cli.ts` - New commands and flags
- `src/db/init.ts` - Migration system
- `src/db/traces.ts` - Significance field
- `src/db/encodes.ts` - Memory type, decay, boot enhancement
- `src/db/bonds.ts` - New bonds module
- `src/encode/pipeline.ts` - Classification, bonds, contradictions
- `src/trace/capture.ts` - Significance scoring

## Backwards Compatibility
- All existing data preserved
- Default values applied during migration
- No breaking changes to existing APIs
- All 1,684 encodes survive migration intact

## Commit
`e2bf46c` - v0.3: Decay rates, Memory Bonds, Contradiction Detection, Significance Scoring
