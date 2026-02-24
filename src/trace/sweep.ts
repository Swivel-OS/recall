import { readdirSync, readFileSync, statSync } from 'fs';
import { join, extname, basename } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { captureTrace } from './capture.js';
import { getTraceByContentHash } from '../db/traces.js';

export interface SweepOptions {
  sinceHours: number;
  dryRun: boolean;
}

export interface SweepResults {
  filesScanned: number;
  tracesFound: number;
  tracesCreated: number;
  duplicatesSkipped: number;
}

interface JsonlEntry {
  role?: string;
  content?: string;
  timestamp?: string;
  type?: string;
  [key: string]: any;
}

interface ConversationSegment {
  content: string;
  type: 'conversation' | 'decision' | 'task_completion';
  timestamp: string;
  participants: string[];
}

export async function sweepSessions(options: SweepOptions): Promise<SweepResults> {
  const results: SweepResults = {
    filesScanned: 0,
    tracesFound: 0,
    tracesCreated: 0,
    duplicatesSkipped: 0
  };

  const sweepPath = process.env.RECALL_SWEEP_PATH || join(homedir(), '.openclaw/workspace');
  const cutoffTime = Date.now() - (options.sinceHours * 60 * 60 * 1000);

  let files: string[];
  try {
    files = readdirSync(sweepPath).filter(f => extname(f) === '.jsonl');
  } catch (e) {
    console.error(`Failed to read sweep path: ${sweepPath}`);
    return results;
  }

  for (const file of files) {
    const filePath = join(sweepPath, file);

    try {
      const stats = statSync(filePath);
      if (stats.mtimeMs < cutoffTime) continue;

      results.filesScanned++;
      const segments = extractSegmentsFromJsonl(filePath);

      for (const segment of segments) {
        results.tracesFound++;

        // Generate content hash for deduplication
        const contentHash = createHash('sha256').update(segment.content).digest('hex');

        // Check for duplicates
        const existing = getTraceByContentHash(contentHash);
        if (existing) {
          results.duplicatesSkipped++;
          continue;
        }

        if (!options.dryRun) {
          try {
            captureTrace({
              agent_id: extractAgentId(file),
              session_id: extractSessionId(file),
              content_raw: segment.content,
              participants: segment.participants,
              channel: 'openclaw',
              trace_type: segment.type,
              is_identity_trace: false
            });
            results.tracesCreated++;
          } catch (e) {
            console.error(`Failed to capture trace from ${file}:`, e);
          }
        } else {
          results.tracesCreated++; // Count as "would create" in dry run
        }
      }
    } catch (e) {
      console.error(`Error processing ${file}:`, e);
    }
  }

  return results;
}

function extractSegmentsFromJsonl(filePath: string): ConversationSegment[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(line => line.trim());

  const entries: JsonlEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch (e) {
      // Skip invalid lines
    }
  }

  const segments: ConversationSegment[] = [];
  const conversationBuffer: string[] = [];
  let bufferStartTime: string | null = null;
  const participants = new Set<string>();

  for (const entry of entries) {
    // Skip system/tool entries
    if (entry.role === 'system' || entry.type === 'tool') continue;

    const text = entry.content || '';
    const role = entry.role || 'user';
    participants.add(role);

    if (!bufferStartTime) {
      bufferStartTime = entry.timestamp || new Date().toISOString();
    }

    // Check for decision/completion markers
    const decisionMarkers = [
      /decided?\s+to/i,
      /(will|shall|should)\s+\w+/i,
      /conclusion:\s*/i,
      /(agreed?|decision):/i,
      /let's\s+\w+/i
    ];

    const completionMarkers = [
      /complet(ed|ion)/i,
      /finish(ed)?/i,
      /done[.!]?$/im,
      /success(fully)?/i,
      /task\s+complete/i
    ];

    const isDecision = decisionMarkers.some(m => m.test(text));
    const isCompletion = completionMarkers.some(m => m.test(text));

    // Flush conversation buffer on significant events
    if (isDecision || isCompletion) {
      if (conversationBuffer.length > 0) {
        segments.push({
          content: conversationBuffer.join('\n\n'),
          type: 'conversation',
          timestamp: bufferStartTime!,
          participants: Array.from(participants)
        });
        conversationBuffer.length = 0;
        participants.clear();
      }

      segments.push({
        content: text,
        type: isDecision ? 'decision' : 'task_completion',
        timestamp: entry.timestamp || new Date().toISOString(),
        participants: [role]
      });

      bufferStartTime = null;
    } else {
      conversationBuffer.push(`[${role}] ${text}`);
    }
  }

  // Flush remaining buffer
  if (conversationBuffer.length > 0) {
    segments.push({
      content: conversationBuffer.join('\n\n'),
      type: 'conversation',
      timestamp: bufferStartTime || new Date().toISOString(),
      participants: Array.from(participants)
    });
  }

  return segments;
}

function extractAgentId(filename: string): string {
  // Try to extract agent from filename patterns like agent-name-timestamp.jsonl
  const match = filename.match(/^([a-zA-Z0-9_-]+)-/);
  return match ? match[1] : 'unknown';
}

function extractSessionId(filename: string): string {
  // Extract session ID from filename without extension
  return basename(filename, '.jsonl');
}
