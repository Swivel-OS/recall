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
  encode_status: 'pending';
  created_at: string;
}

export function captureTrace(input: CaptureInput): CapturedTrace {
  const now = new Date();
  const traceId = uuidv4();
  const sessionSeq = getNextSessionSeq(input.session_id);
  
  // Generate content hash
  const contentHash = createHash('sha256')
    .update(input.content_raw)
    .digest('hex');
  
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
    encode_status: 'pending',
    created_at: traceInput.created_at
  };
}
