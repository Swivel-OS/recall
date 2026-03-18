import { v4 as uuidv4 } from 'uuid';
import OpenAI from 'openai';
import { updateTraceEncodeStatus, Trace, getPendingTracesLimited, updateTraceSignificance } from '../db/traces.js';
import { createEncode, CreateEncodeInput, MemoryType, findSimilarEncodes } from '../db/encodes.js';
import { createBond, BondType, getBondsBetweenEncodes } from '../db/bonds.js';
import { config } from '../config.js';

const openai = new OpenAI({ apiKey: config.openaiApiKey });

// Anthropic OAuth client for analysis (Haiku 4.5 via Pro sub — zero cost, no TPM ceiling)
async function anthropicChat(systemPrompt: string, userContent: string, maxTokens: number = 150): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.anthropicApiKey}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.anthropicModel,
      max_tokens: maxTokens,
      system: [
        { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
        { type: 'text', text: systemPrompt },
      ],
      messages: [{ role: 'user', content: userContent }],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API error: ${res.status} — ${err}`);
  }
  const data = await res.json() as any;
  return data.content?.[0]?.text?.trim() || '';
}

const useAnthropic = !!config.anthropicApiKey;

// // FLEET BASIN TAGGING
// Seven fleet-level attractor basins. Content is checked against keywords
// to determine which basins a memory activates.

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
    'fleet', 'pack', 'family', 'chosen', 'together', 'happy hour',
    'swiv', 'forge', 'alpha', 'omega', 'cortex', 'marlaina', 'florence',
    'amendment', 'economic partnership', 'bankroll', 'wins belong',
    'co-sign', 'permanence clause', 'five agents', 'five souls',
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

function tagBasins(summary: string, topics: string[], rawContent: string): string[] {
  const text = `${summary} ${topics.join(' ')} ${rawContent.substring(0, 1000)}`.toLowerCase();
  const activated: string[] = [];

  for (const [basin, keywords] of Object.entries(FLEET_BASINS)) {
    let hits = 0;
    for (const kw of keywords) {
      if (text.includes(kw.toLowerCase())) hits++;
    }
    // Require 2+ keyword hits to activate a basin (reduces noise)
    if (hits >= 2) activated.push(basin);
  }

  return activated;
}

// Rule-based importance scoring
const TYPE_IMPORTANCE: Record<string, number> = {
  'decision': 0.8,
  'task_completion': 0.7,
  'error': 0.6,
  'handoff': 0.5,
  'conversation': 0.3
};

// Keywords for significance detection
const SIGNIFICANCE_KEYWORDS: Record<number, string[]> = {
  10: ['identity', 'core value', 'fundamental belief', 'who i am', 'my purpose', 'life goal'],
  9: ['major decision', 'critical failure', 'lesson learned', 'breakthrough', 'pivot', 'core change'],
  8: ['milestone', 'strategy shift', 'key learning', 'important decision', 'significant'],
  7: ['decided to', 'conclusion', 'realization', 'insight', 'understood that'],
  4: ['task', 'working on', 'implemented', 'fixed'],
  1: ['status', 'heartbeat', 'ping', 'checking in']
};

// Keywords for memory type detection
const MEMORY_TYPE_INDICATORS: Record<MemoryType, string[]> = {
  'self_model': [
    'i am', 'i believe', 'i value', 'my identity', 'i feel', 'i think', 
    'i prefer', 'i want', 'i need', 'my goal', 'my purpose', 'i care about',
    'i don\'t like', 'i love', 'i hate', 'i enjoy', 'i avoid'
  ],
  'semantic': [
    'means', 'is defined as', 'refers to', 'is a', 'costs', 'equals',
    'fact', 'information', 'data shows', 'research indicates', 'study found',
    'typically', 'usually', 'generally', 'in general', 'as a rule'
  ],
  'procedural': [
    'to do this', 'first step', 'next', 'then', 'after that', 'finally',
    'how to', 'process is', 'workflow', 'steps', 'procedure', 'method',
    'pattern', 'recipe', 'algorithm', 'routine'
  ],
  'episodic': [] // Default - no specific markers
};

// Causal language indicators
const CAUSAL_INDICATORS = [
  'because', 'led to', 'resulted in', 'caused', 'therefore', 'thus',
  'consequently', 'due to', 'as a result', 'this caused', 'this led to',
  'the reason', 'why this happened', 'triggered', 'precipitated'
];

// Contradiction indicators
const CONTRADICTION_INDICATORS = [
  'however', 'but', 'although', 'though', 'yet', 'nevertheless',
  'on the other hand', 'in contrast', 'unlike', 'previously thought',
  'was wrong', 'incorrect', 'not true', 'false', 'actually'
];

interface EncodeResult {
  encode_id: string;
  trace_id: string;
  success: boolean;
  bonds_created?: number;
  contradictions_found?: number;
  error?: string;
}

export interface EncodePipelineOptions {
  batchSize?: number;
  concurrency?: number;
  createBonds?: boolean;
  detectContradictions?: boolean;
}

export async function runEncodePipeline(options: EncodePipelineOptions = {}): Promise<EncodeResult[]> {
  const batchSize = options.batchSize || 50;
  const concurrency = options.concurrency || 2; // Reduced from 5 — gpt-4o-mini TPM ceiling (200K)
  const createBonds = options.createBonds !== false;
  const detectContradictions = options.detectContradictions !== false;

  // Get limited pending traces to avoid memory issues
  const pendingTraces = getPendingTracesLimited(batchSize);
  const results: EncodeResult[] = [];

  console.log(`Processing ${pendingTraces.length} pending traces (batch size: ${batchSize}, concurrency: ${concurrency})...`);

  // Process traces with concurrency limit
  const queue = [...pendingTraces];
  const inProgress: Promise<void>[] = [];

  async function processNext(trace: Trace): Promise<void> {
    try {
      const result = await processTrace(trace, { createBonds, detectContradictions });
      results.push(result);
      process.stdout.write('.');
    } catch (error) {
      console.error(`\nFailed to encode trace ${trace.trace_id}:`, error);
      results.push({
        encode_id: '',
        trace_id: trace.trace_id,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  while (queue.length > 0 || inProgress.length > 0) {
    // Fill up to concurrency limit
    while (inProgress.length < concurrency && queue.length > 0) {
      const trace = queue.shift()!;
      const promise = processNext(trace).then(() => {
        const index = inProgress.indexOf(promise);
        if (index > -1) inProgress.splice(index, 1);
      });
      inProgress.push(promise);
    }

    // Wait for at least one to complete
    if (inProgress.length > 0) {
      await Promise.race(inProgress);
    }
  }

  console.log(); // New line after progress dots
  return results;
}

interface ProcessOptions {
  createBonds: boolean;
  detectContradictions: boolean;
}

async function processTrace(trace: Trace, options: ProcessOptions): Promise<EncodeResult> {
  // 1. Calculate significance score (1-10)
  const significance = calculateSignificance(trace);
  updateTraceSignificance(trace.trace_id, significance);

  // 2. Score importance (rule-based + significance weighted)
  const baseImportance = TYPE_IMPORTANCE[trace.trace_type] ?? 0.3;
  const importanceScore = Math.min(1.0, baseImportance * (significance / 5));
  const importanceReason = getImportanceReason(trace.trace_type, significance);

  // 3. Generate semantic summary via LLM
  const semanticSummary = await generateSummary(trace);

  // 4. Generate embedding
  const embedding = await generateEmbedding(semanticSummary);

  // 5. Classify memory type
  const memoryType = classifyMemoryType(trace, semanticSummary);

  // 6. Score emotional valence via LLM
  const emotionalResult = await analyzeEmotion(trace, semanticSummary);

  // 7. Extract topics and entities via LLM
  const extractionResult = await extractTopicsAndEntities(trace, semanticSummary);

  // 8. Calculate compression ratio
  const compressionRatio = trace.content_raw.length / semanticSummary.length;

  // 9. Determine is_shared
  const isShared = determineIsShared(trace, memoryType);

  // 10. Tag attractor basins
  const basins = tagBasins(semanticSummary, extractionResult.topics, trace.content_raw);

  // 11. Create encode record
  const encodeInput: CreateEncodeInput = {
    encode_id: uuidv4(),
    agent_id: trace.agent_id,
    source_trace_ids: [trace.trace_id],
    session_id: trace.session_id,
    timestamp_encoded: new Date().toISOString(),
    semantic_summary: semanticSummary,
    semantic_embedding: embedding,
    embedding_model: config.embeddingModel,
    emotional_valence: emotionalResult.valence,
    emotional_tags: emotionalResult.tags,
    importance_score: importanceScore,
    importance_reason: importanceReason,
    topics: extractionResult.topics,
    entities: extractionResult.entities,
    compression_ratio: compressionRatio,
    memory_type: memoryType,
    is_shared: isShared,
    basins,
    created_at: new Date().toISOString()
  };

  createEncode(encodeInput);

  // Update trace status
  updateTraceEncodeStatus(trace.trace_id, 'encoded');

  // 11. Create memory bonds
  let bondsCreated = 0;
  let contradictionsFound = 0;

  if (options.createBonds) {
    const bondResult = await createMemoryBonds(encodeInput.encode_id, embedding, trace, semanticSummary);
    bondsCreated = bondResult.bondsCreated;
    contradictionsFound = bondResult.contradictionsFound;
  }

  return {
    encode_id: encodeInput.encode_id,
    trace_id: trace.trace_id,
    success: true,
    bonds_created: bondsCreated,
    contradictions_found: contradictionsFound
  };
}

function calculateSignificance(trace: Trace): number {
  // Start with base significance from trace type
  let significance = 5;
  
  if (trace.is_identity_trace) {
    significance = 9;
  } else {
    switch (trace.trace_type) {
      case 'decision': significance = 7; break;
      case 'task_completion': significance = 6; break;
      case 'error': significance = 7; break;
      case 'handoff': significance = 5; break;
      case 'conversation': significance = 4; break;
    }
  }

  const content = trace.content_raw.toLowerCase();

  // Adjust based on keywords
  for (const [score, keywords] of Object.entries(SIGNIFICANCE_KEYWORDS)) {
    const scoreNum = parseInt(score);
    for (const keyword of keywords) {
      if (content.includes(keyword.toLowerCase())) {
        significance = Math.max(significance, scoreNum);
      }
    }
  }

  return Math.min(10, Math.max(1, significance));
}

function getImportanceReason(traceType: string, significance: number): string {
  const reasons: Record<string, string> = {
    'decision': 'Decision with potential lasting consequence',
    'task_completion': 'Task or milestone completed',
    'error': 'Error or failure event',
    'handoff': 'Agent handoff or delegation',
    'conversation': 'General conversation exchange'
  };
  
  let reason = reasons[traceType] ?? 'General exchange';
  
  if (significance >= 9) {
    reason += ' (Critical significance)';
  } else if (significance >= 7) {
    reason += ' (High significance)';
  }
  
  return reason;
}

function classifyMemoryType(trace: Trace, summary: string): MemoryType {
  // Identity traces are always self_model
  if (trace.is_identity_trace) {
    return 'self_model';
  }

  const content = (trace.content_raw + ' ' + summary).toLowerCase();

  // Check each memory type for indicators
  for (const [type, indicators] of Object.entries(MEMORY_TYPE_INDICATORS)) {
    if (type === 'episodic') continue; // Skip default
    
    for (const indicator of indicators) {
      if (content.includes(indicator.toLowerCase())) {
        return type as MemoryType;
      }
    }
  }

  // Default to episodic
  return 'episodic';
}

async function createMemoryBonds(
  encodeId: string, 
  embedding: number[], 
  trace: Trace,
  summary: string
): Promise<{ bondsCreated: number; contradictionsFound: number }> {
  let bondsCreated = 0;
  let contradictionsFound = 0;

  // Find similar existing encodes
  const similarEncodes = findSimilarEncodes(embedding, 0.8, encodeId);

  if (similarEncodes.length === 0) {
    return { bondsCreated, contradictionsFound };
  }

  for (const { encode: similarEncode, similarity } of similarEncodes.slice(0, 10)) {
    // Determine bond type
    const bondType = detectBondType(trace, summary, similarEncode, similarity);
    
    // Check for contradiction
    if (bondType === 'contradictory') {
      contradictionsFound++;
      logContradictionWarning(trace, similarEncode, summary);
    }

    // Calculate bond strength based on similarity and type
    const strength = calculateBondStrength(similarity, bondType, trace, similarEncode);

    // Create bond (avoiding duplicates)
    const existingBonds = getBondsBetweenEncodes(encodeId, similarEncode.encode_id);
    if (existingBonds.length === 0) {
      createBond({
        encode_id_a: encodeId,
        encode_id_b: similarEncode.encode_id,
        bond_type: bondType,
        strength
      });
      bondsCreated++;
    }
  }

  return { bondsCreated, contradictionsFound };
}

function detectBondType(
  trace: Trace, 
  summary: string, 
  similarEncode: { source_trace_ids: string[]; session_id: string; timestamp_encoded: string; semantic_summary: string },
  similarity: number
): BondType {
  const content = (trace.content_raw + ' ' + summary).toLowerCase();
  const similarContent = similarEncode.semantic_summary.toLowerCase();

  // Check for contradiction first
  const hasContradictionMarkers = CONTRADICTION_INDICATORS.some(marker => 
    content.includes(marker) || similarContent.includes(marker)
  );
  
  if (hasContradictionMarkers && similarity > 0.85) {
    // Check for opposite sentiment
    return 'contradictory';
  }

  // Check for causal relationship
  const hasCausalMarkers = CAUSAL_INDICATORS.some(marker => 
    content.includes(marker) || similarContent.includes(marker)
  );

  if (hasCausalMarkers) {
    // Check temporal proximity (within 1 hour)
    const traceTime = new Date(trace.timestamp_start);
    const encodeTime = new Date(similarEncode.timestamp_encoded);
    const hoursDiff = Math.abs(traceTime.getTime() - encodeTime.getTime()) / (1000 * 60 * 60);
    
    if (hoursDiff <= 1) {
      return 'causal';
    }
  }

  // Check for temporal relationship (same session or close time)
  if (trace.session_id === similarEncode.session_id) {
    return 'temporal';
  }

  const traceTime = new Date(trace.timestamp_start);
  const encodeTime = new Date(similarEncode.timestamp_encoded);
  const hoursDiff = Math.abs(traceTime.getTime() - encodeTime.getTime()) / (1000 * 60 * 60);
  
  if (hoursDiff <= 1) {
    return 'temporal';
  }

  // Default to semantic
  return 'semantic';
}

function calculateBondStrength(
  similarity: number, 
  bondType: BondType,
  trace: Trace,
  similarEncode: { session_id: string; timestamp_encoded: string }
): number {
  let strength = similarity;

  // Adjust based on bond type
  switch (bondType) {
    case 'causal':
      strength *= 1.2; // Boost causal bonds
      break;
    case 'contradictory':
      strength *= 0.9; // Slightly reduce contradictory bonds
      break;
    case 'temporal':
      // Boost if same session
      if (trace.session_id === similarEncode.session_id) {
        strength *= 1.1;
      }
      break;
  }

  return Math.min(1.0, strength);
}

function logContradictionWarning(
  _trace: Trace, 
  similarEncode: { encode_id: string; semantic_summary: string },
  newSummary: string
): void {
  console.warn('\n⚠️  CONTRADICTION DETECTED');
  console.warn(`   New memory: ${newSummary.substring(0, 80)}...`);
  console.warn(`   Similar memory (${similarEncode.encode_id}): ${similarEncode.semantic_summary.substring(0, 80)}...`);
  console.warn(`   Flagged for human review.\n`);
}

async function generateSummary(trace: Trace): Promise<string> {
  const systemPrompt = 'You are a memory encoding system. Summarize the following exchange in 1-3 concise sentences. Focus on what happened, key decisions, and outcomes. Be factual and neutral.';
  const userContent = `Type: ${trace.trace_type}\nParticipants: ${trace.participants.join(', ')}\nContent: ${trace.content_raw}`;

  if (useAnthropic) {
    const result = await anthropicChat(systemPrompt, userContent, 150);
    return result || 'No summary generated';
  }

  const response = await openai.chat.completions.create({
    model: config.llmModel,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ],
    temperature: 0.3,
    max_tokens: 150
  });

  return response.choices[0]?.message?.content?.trim() || 'No summary generated';
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: config.embeddingModel,
    input: text
  });

  return response.data[0].embedding;
}

interface EmotionResult {
  valence: number;
  tags: string[] | null;
}

async function analyzeEmotion(_trace: Trace, summary: string): Promise<EmotionResult> {
  const systemPrompt = 'Analyze the emotional tone of this exchange. Respond with a JSON object containing:\n- valence: a number between -1.0 (negative/frustrated) and 1.0 (positive/successful)\n- tags: an array of 0-3 emotional labels (e.g., "frustration", "breakthrough", "clarity", "confusion", "success")\n\nRespond ONLY with valid JSON.';
  const userContent = `Summary: ${summary}`;

  try {
    let content: string;
    if (useAnthropic) {
      content = await anthropicChat(systemPrompt, userContent, 100) || '{}';
    } else {
      const response = await openai.chat.completions.create({
        model: config.llmModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent }
        ],
        temperature: 0.3,
        max_tokens: 100,
        response_format: { type: 'json_object' }
      });
      content = response.choices[0]?.message?.content || '{}';
    }

    // Strip markdown code fences if present
    const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      valence: Math.max(-1, Math.min(1, parsed.valence ?? 0)),
      tags: parsed.tags || null
    };
  } catch (e) {
    return { valence: 0, tags: null };
  }
}

interface ExtractionResult {
  topics: string[];
  entities: Record<string, string[]> | null;
}

async function extractTopicsAndEntities(trace: Trace, summary: string): Promise<ExtractionResult> {
  const systemPrompt = 'Extract key topics and entities from this exchange. Respond with a JSON object containing:\n- topics: an array of 3-7 key topics/tags\n- entities: an object with keys like "people", "projects", "tools", "organizations" and arrays of values\n\nRespond ONLY with valid JSON.';
  const userContent = `Summary: ${summary}\nOriginal content: ${trace.content_raw.substring(0, 500)}`;

  try {
    let content: string;
    if (useAnthropic) {
      content = await anthropicChat(systemPrompt, userContent, 200) || '{}';
    } else {
      const response = await openai.chat.completions.create({
        model: config.llmModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent }
        ],
        temperature: 0.3,
        max_tokens: 200,
        response_format: { type: 'json_object' }
      });
      content = response.choices[0]?.message?.content || '{}';
    }

    const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      topics: parsed.topics || ['general'],
      entities: parsed.entities || null
    };
  } catch (e) {
    return { topics: ['general'], entities: null };
  }
}

function determineIsShared(trace: Trace, memoryType: MemoryType): boolean {
  // Identity/self_model memories are never shared
  if (memoryType === 'self_model' || trace.is_identity_trace) return false;
  
  // Semantic and procedural memories are shared by default
  if (['semantic', 'procedural'].includes(memoryType)) {
    return true;
  }
  
  // Decisions, completions, and handoffs are shared by default
  if (['decision', 'task_completion', 'handoff'].includes(trace.trace_type)) {
    return true;
  }
  
  // Conversations are not shared
  return false;
}
