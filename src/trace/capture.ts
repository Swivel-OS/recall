import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { createTrace, getNextSessionSeq, CreateTraceInput } from '../db/traces.js';

export interface CaptureInput {
  agent_id: string;
  session_id: string;
  content_raw: string;
  participants: string[];
  channel: string;
  trace_type: 'conversation' | 'decision' | 'task_completion' | 'error' | 'handoff';
  is_identity_trace?: boolean;
  tags?: string[];
}

export interface CapturedTrace {
  trace_id: string;
  agent_id: string;
  session_id: string;
  session_seq: number;
  timestamp_start: string;
  timestamp_end: string;
  content_raw: string;
  content_hash: string;
  participants: string[];
  channel: string;
  trace_type: string;
  is_identity_trace: boolean;
  significance: number;
  tags?: string[];
  encode_status: 'pending';
  created_at: string;
}

// Keywords for significance detection
const SIGNIFICANCE_KEYWORDS: Record<number, string[]> = {
  10: ['identity', 'core value', 'fundamental belief', 'who i am', 'my purpose', 'life goal'],
  9: ['major decision', 'critical failure', 'lesson learned', 'breakthrough', 'pivot', 'core change'],
  8: ['milestone', 'strategy shift', 'key learning', 'important decision', 'significant'],
  7: ['decided to', 'conclusion', 'realization', 'insight', 'understood that'],
  4: ['task', 'working on', 'implemented', 'fixed'],
  1: ['status', 'heartbeat', 'ping', 'checking in']
};

export function captureTrace(input: CaptureInput): CapturedTrace {
  const now = new Date();
  const traceId = uuidv4();
  const sessionSeq = getNextSessionSeq(input.session_id);
  
  // Generate content hash
  const contentHash = createHash('sha256')
    .update(input.content_raw)
    .digest('hex');

  // Calculate significance score
  const significance = calculateSignificance(input);
  
  const traceInput: CreateTraceInput = {
    trace_id: traceId,
    agent_id: input.agent_id,
    session_id: input.session_id,
    session_seq: sessionSeq,
    timestamp_start: now.toISOString(),
    timestamp_end: now.toISOString(),
    content_raw: input.content_raw.trim(),
    content_hash: contentHash,
    participants: input.participants,
    channel: input.channel,
    trace_type: input.trace_type,
    is_identity_trace: input.is_identity_trace ?? false,
    significance: significance,
    tags: input.tags,
    created_at: now.toISOString()
  };

  createTrace(traceInput);

  return {
    trace_id: traceId,
    agent_id: input.agent_id,
    session_id: input.session_id,
    session_seq: sessionSeq,
    timestamp_start: traceInput.timestamp_start,
    timestamp_end: traceInput.timestamp_end,
    content_raw: traceInput.content_raw,
    content_hash: contentHash,
    participants: input.participants,
    channel: input.channel,
    trace_type: input.trace_type,
    is_identity_trace: traceInput.is_identity_trace,
    significance: significance,
    encode_status: 'pending',
    created_at: traceInput.created_at
  };
}

function calculateSignificance(input: CaptureInput): number {
  // Start with base significance from trace type
  let significance = 5;
  
  if (input.is_identity_trace) {
    significance = 9;
  } else {
    switch (input.trace_type) {
      case 'decision': significance = 7; break;
      case 'task_completion': significance = 6; break;
      case 'error': significance = 7; break;
      case 'handoff': significance = 5; break;
      case 'conversation': significance = 4; break;
    }
  }

  const content = input.content_raw.toLowerCase();

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
