import { getDb } from './init.js';

export type TraceType = 'conversation' | 'decision' | 'task_completion' | 'error' | 'handoff';
export type EncodeStatus = 'pending' | 'encoded' | 'skipped';

export interface Trace {
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
  trace_type: TraceType;
  is_identity_trace: boolean;
  encode_status: EncodeStatus;
  created_at: string;
}

export interface CreateTraceInput {
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
  trace_type: TraceType;
  is_identity_trace: boolean;
  created_at: string;
}

export function createTrace(input: CreateTraceInput): Trace {
  const db = getDb();
  
  const stmt = db.prepare(`
    INSERT INTO traces (
      trace_id, agent_id, session_id, session_seq, timestamp_start, timestamp_end,
      content_raw, content_hash, participants, channel, trace_type, 
      is_identity_trace, encode_status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `);

  stmt.run(
    input.trace_id,
    input.agent_id,
    input.session_id,
    input.session_seq,
    input.timestamp_start,
    input.timestamp_end,
    input.content_raw,
    input.content_hash,
    JSON.stringify(input.participants),
    input.channel,
    input.trace_type,
    input.is_identity_trace ? 1 : 0,
    input.created_at
  );

  return {
    ...input,
    encode_status: 'pending',
    participants: input.participants
  };
}

export function getTraceById(traceId: string): Trace | null {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM traces WHERE trace_id = ?');
  const row = stmt.get(traceId) as any;
  
  if (!row) return null;
  
  return rowToTrace(row);
}

export function getPendingTraces(): Trace[] {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM traces WHERE encode_status = ? ORDER BY created_at ASC');
  const rows = stmt.all('pending') as any[];
  
  return rows.map(rowToTrace);
}

export function updateTraceEncodeStatus(traceId: string, status: EncodeStatus): void {
  const db = getDb();
  const stmt = db.prepare('UPDATE traces SET encode_status = ? WHERE trace_id = ?');
  stmt.run(status, traceId);
}

export function getNextSessionSeq(sessionId: string): number {
  const db = getDb();
  const stmt = db.prepare('SELECT MAX(session_seq) as max_seq FROM traces WHERE session_id = ?');
  const row = stmt.get(sessionId) as any;
  return (row?.max_seq || 0) + 1;
}

export function getTraceCount(): number {
  const db = getDb();
  const stmt = db.prepare('SELECT COUNT(*) as count FROM traces');
  const row = stmt.get() as any;
  return row.count;
}

export function getTraceCountByStatus(status: EncodeStatus): number {
  const db = getDb();
  const stmt = db.prepare('SELECT COUNT(*) as count FROM traces WHERE encode_status = ?');
  const row = stmt.get(status) as any;
  return row.count;
}

function rowToTrace(row: any): Trace {
  return {
    trace_id: row.trace_id,
    agent_id: row.agent_id,
    session_id: row.session_id,
    session_seq: row.session_seq,
    timestamp_start: row.timestamp_start,
    timestamp_end: row.timestamp_end,
    content_raw: row.content_raw,
    content_hash: row.content_hash,
    participants: JSON.parse(row.participants),
    channel: row.channel,
    trace_type: row.trace_type as TraceType,
    is_identity_trace: row.is_identity_trace === 1,
    encode_status: row.encode_status as EncodeStatus,
    created_at: row.created_at
  };
}
