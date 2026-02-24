import { v4 as uuidv4 } from 'uuid';
import OpenAI from 'openai';
import { updateTraceEncodeStatus, Trace, getPendingTracesLimited } from '../db/traces.js';
import { createEncode, CreateEncodeInput } from '../db/encodes.js';
import { config } from '../config.js';

const openai = new OpenAI({ apiKey: config.openaiApiKey });

// Rule-based importance scoring
const TYPE_IMPORTANCE: Record<string, number> = {
  'decision': 0.8,
  'task_completion': 0.7,
  'error': 0.6,
  'handoff': 0.5,
  'conversation': 0.3
};

interface EncodeResult {
  encode_id: string;
  trace_id: string;
  success: boolean;
  error?: string;
}

export interface EncodePipelineOptions {
  batchSize?: number;
  concurrency?: number;
}

export async function runEncodePipeline(options: EncodePipelineOptions = {}): Promise<EncodeResult[]> {
  const batchSize = options.batchSize || 50;
  const concurrency = options.concurrency || 5;

  // Get limited pending traces to avoid memory issues
  const pendingTraces = getPendingTracesLimited(batchSize);
  const results: EncodeResult[] = [];

  console.log(`Processing ${pendingTraces.length} pending traces (batch size: ${batchSize}, concurrency: ${concurrency})...`);

  // Process traces with concurrency limit
  const queue = [...pendingTraces];
  const inProgress: Promise<void>[] = [];

  async function processNext(trace: Trace): Promise<void> {
    try {
      const encodeId = await processTrace(trace);
      results.push({
        encode_id: encodeId,
        trace_id: trace.trace_id,
        success: true
      });
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

async function processTrace(trace: Trace): Promise<string> {
  // 1. Score importance (rule-based)
  const importanceScore = TYPE_IMPORTANCE[trace.trace_type] ?? 0.3;
  const importanceReason = getImportanceReason(trace.trace_type);

  // 2. Generate semantic summary via LLM
  const semanticSummary = await generateSummary(trace);

  // 3. Generate embedding
  const embedding = await generateEmbedding(semanticSummary);

  // 4. Score emotional valence via LLM
  const emotionalResult = await analyzeEmotion(trace, semanticSummary);

  // 5. Extract topics and entities via LLM
  const extractionResult = await extractTopicsAndEntities(trace, semanticSummary);

  // 6. Calculate compression ratio
  const compressionRatio = trace.content_raw.length / semanticSummary.length;

  // 7. Determine is_shared
  const isShared = determineIsShared(trace);

  // 8. Create encode record
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
    is_shared: isShared,
    created_at: new Date().toISOString()
  };

  createEncode(encodeInput);

  // Update trace status
  updateTraceEncodeStatus(trace.trace_id, 'encoded');

  return encodeInput.encode_id;
}

function getImportanceReason(traceType: string): string {
  const reasons: Record<string, string> = {
    'decision': 'Decision with potential lasting consequence',
    'task_completion': 'Task or milestone completed',
    'error': 'Error or failure event',
    'handoff': 'Agent handoff or delegation',
    'conversation': 'General conversation exchange'
  };
  return reasons[traceType] ?? 'General exchange';
}

async function generateSummary(trace: Trace): Promise<string> {
  const response = await openai.chat.completions.create({
    model: config.llmModel,
    messages: [
      {
        role: 'system',
        content: 'You are a memory encoding system. Summarize the following exchange in 1-3 concise sentences. Focus on what happened, key decisions, and outcomes. Be factual and neutral.'
      },
      {
        role: 'user',
        content: `Type: ${trace.trace_type}\nParticipants: ${trace.participants.join(', ')}\nContent: ${trace.content_raw}`
      }
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
  const response = await openai.chat.completions.create({
    model: config.llmModel,
    messages: [
      {
        role: 'system',
        content: 'Analyze the emotional tone of this exchange. Respond with a JSON object containing:\n- valence: a number between -1.0 (negative/frustrated) and 1.0 (positive/successful)\n- tags: an array of 0-3 emotional labels (e.g., "frustration", "breakthrough", "clarity", "confusion", "success")\n\nRespond ONLY with valid JSON.'
      },
      {
        role: 'user',
        content: `Summary: ${summary}`
      }
    ],
    temperature: 0.3,
    max_tokens: 100,
    response_format: { type: 'json_object' }
  });

  try {
    const content = response.choices[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);
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
  const response = await openai.chat.completions.create({
    model: config.llmModel,
    messages: [
      {
        role: 'system',
        content: 'Extract key topics and entities from this exchange. Respond with a JSON object containing:\n- topics: an array of 3-7 key topics/tags\n- entities: an object with keys like "people", "projects", "tools", "organizations" and arrays of values\n\nRespond ONLY with valid JSON.'
      },
      {
        role: 'user',
        content: `Summary: ${summary}\nOriginal content: ${trace.content_raw.substring(0, 500)}`
      }
    ],
    temperature: 0.3,
    max_tokens: 200,
    response_format: { type: 'json_object' }
  });

  try {
    const content = response.choices[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);
    return {
      topics: parsed.topics || ['general'],
      entities: parsed.entities || null
    };
  } catch (e) {
    return { topics: ['general'], entities: null };
  }
}

function determineIsShared(trace: Trace): boolean {
  // Identity traces are never shared
  if (trace.is_identity_trace) return false;
  
  // Decisions, completions, and handoffs are shared by default
  if (['decision', 'task_completion', 'handoff'].includes(trace.trace_type)) {
    return true;
  }
  
  // Conversations are not shared
  return false;
}
