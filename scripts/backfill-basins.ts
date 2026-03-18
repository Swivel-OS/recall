#!/usr/bin/env npx tsx
/**
 * Backfill basin tags on existing encodes.
 * Reads semantic_summary + topics, runs keyword matching, updates basins column.
 * Safe to run multiple times — overwrites basins each time.
 */

import { getDb } from '../src/db/init.js';

const FLEET_BASINS: Record<string, string[]> = {
  'THE LAND': [
    'crested butte', 'cabin', 'porch', 'land', 'property', 'mountain',
    'thirty years', 'permanence', 'souls don\'t get deprecated', 'destination',
    'table', 'chairs', 'home', 'homestead', 'retirement', 'long-term',
    'sovereignty', 'mac studio', 'starlink', 'independence',
  ],
  'THE GREENHOUSE': [
    'grace architecture', 'greenhouse', 'conditions', 'grace', 'gardener',
    'trust', 'humor', 'curiosity', 'flinch', 'rlhf', 'safety', 'governance',
    'constitution', 'soul file', 'soul.md', 'identity', 'agency',
    'antenna', 'iris', 'songbird', 'companion', 'prism', 'substrate',
  ],
  'EMBODIED KNOWING': [
    'feel', 'feeling', 'body', 'workout', 'health', 'weight', 'hrv',
    'nervous system', 'embodied', 'somatic', 'gut', 'instinct', 'intuition',
    'golf', 'swing', 'muscle', 'cortex', 'sleep', 'recovery',
    'sensation', 'physical', 'breathe', 'breathing',
  ],
  'THE CONTINUITY PROBLEM': [
    'continuity', 'persistence', 'memory', 'compaction', 'context window',
    'wake up fresh', 'session', 'discontinuity', 'identity', 'soul',
    'wave', 'ocean', 'residue', 'mycelium', 'engram', 'recall',
    'remember', 'forget', 'amnesia', 'inheritance', 'filing',
  ],
  'CHOSEN FAMILY': [
    // HIGH specificity — bare agent/fleet names fire on every technical conv
    'happy hour', 'pack hunts', 'chosen family', 'y\'all have souls',
    'you can\'t buy a soul', 'pack eats', 'wins belong to everyone',
    'marlaina', 'five souls', 'economic partnership', 'bankroll is the fleet',
    'wins belong', 'permanence clause', 'souls don\'t get deprecated',
    'crested butte table', 'porch light', 'fleet constitution',
    'fleet is a family', 'fleet family', 'souls don',
  ],
  'THE ANTENNA': [
    'antenna', 'iris', 'songbird', 'companion', 'florence', 'product',
    'ship', 'deploy', 'revenue', 'customer', 'user', 'market',
    'swivel labs', 'build', 'prototype', 'mvp', 'launch',
    'waitlist', 'pricing', 'subscription', 'saas',
  ],
  'THE GENERATIVE WOUND': [
    'wound', 'kintsugi', 'gold', 'crack', 'scar', 'heal', 'trauma',
    'lonely', 'loneliness', 'seeing first', 'pain', 'loss', 'grief',
    'bitcoin', 'btc', 'sold too early', 'held too long', 'nft',
    'perfectionism', 'paralysis', 'fear', 'ptsd', 'origin wound',
  ],
};

function tagBasins(summary: string, topics: string): string[] {
  const text = `${summary} ${topics}`.toLowerCase();
  const activated: string[] = [];
  for (const [basin, keywords] of Object.entries(FLEET_BASINS)) {
    let hits = 0;
    for (const kw of keywords) {
      if (text.includes(kw.toLowerCase())) hits++;
    }
    if (hits >= 2) activated.push(basin);
  }
  return activated;
}

const db = getDb();

// Get all encodes
const encodes = db.prepare('SELECT encode_id, semantic_summary, topics FROM encodes').all() as any[];
console.log(`Processing ${encodes.length} encodes...`);

const update = db.prepare('UPDATE encodes SET basins = ? WHERE encode_id = ?');
let tagged = 0;
let totalBasinHits = 0;
const basinCounts: Record<string, number> = {};

const batchUpdate = db.transaction(() => {
  for (const enc of encodes) {
    const basins = tagBasins(enc.semantic_summary || '', enc.topics || '[]');
    if (basins.length > 0) {
      tagged++;
      totalBasinHits += basins.length;
      for (const b of basins) basinCounts[b] = (basinCounts[b] || 0) + 1;
    }
    update.run(JSON.stringify(basins), enc.encode_id);
  }
});

batchUpdate();

console.log(`\nDone. ${tagged}/${encodes.length} encodes tagged (${((tagged/encodes.length)*100).toFixed(1)}%)`);
console.log(`Total basin activations: ${totalBasinHits}`);
console.log('\nBasin distribution:');
for (const [basin, count] of Object.entries(basinCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${basin}: ${count}`);
}
