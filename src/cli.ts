#!/usr/bin/env node

import { initDatabase } from './db/init.js';
import { captureTrace } from './trace/capture.js';
import { runEncodePipeline, generateEmbedding } from './encode/pipeline.js';
import { getTraceCount, getTraceCountByStatus } from './db/traces.js';
import { getEncodeCount, semanticSearch, getRecentEncodesForAgent } from './db/encodes.js';
import { sweepSessions } from './trace/sweep.js';
import { config } from './config.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  try {
    switch (command) {
      case 'trace':
        await handleTrace(args.slice(1));
        break;
      case 'encode':
        await handleEncode(args.slice(1));
        break;
      case 'query':
        await handleQuery(args.slice(1));
        break;
      case 'status':
        await handleStatus();
        break;
      case 'init':
        handleInit();
        break;
      case 'sweep':
        await handleSweep(args.slice(1));
        break;
      case 'boot':
        await handleBoot(args.slice(1));
        break;
      default:
        showHelp();
        break;
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

async function handleTrace(args: string[]): Promise<void> {
  // Check for piped input
  let content = '';
  
  if (!process.stdin.isTTY) {
    // Reading from pipe
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    content = Buffer.concat(chunks).toString().trim();
  }

  // Parse flags
  let agentId = 'unknown';
  let sessionId = 'default';
  let channel = 'terminal';
  let traceType: 'conversation' | 'decision' | 'task_completion' | 'error' | 'handoff' = 'conversation';
  let isIdentity = false;
  let participants: string[] = ['user'];

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--agent':
      case '-a':
        agentId = args[++i];
        break;
      case '--session':
      case '-s':
        sessionId = args[++i];
        break;
      case '--channel':
      case '-c':
        channel = args[++i];
        break;
      case '--type':
      case '-t':
        traceType = args[++i] as any;
        break;
      case '--identity':
      case '-i':
        isIdentity = true;
        break;
      case '--participants':
      case '-p':
        participants = args[++i].split(',');
        break;
      case '--content':
        content = args[++i];
        break;
    }
  }

  if (!content) {
    console.error('Error: No content provided. Use --content or pipe input.');
    process.exit(1);
  }

  const trace = captureTrace({
    agent_id: agentId,
    session_id: sessionId,
    content_raw: content,
    participants,
    channel,
    trace_type: traceType,
    is_identity_trace: isIdentity
  });

  console.log('Trace captured:');
  console.log(`  trace_id: ${trace.trace_id}`);
  console.log(`  session_seq: ${trace.session_seq}`);
  console.log(`  type: ${trace.trace_type}`);
  console.log(`  status: ${trace.encode_status}`);
}

async function handleEncode(args: string[]): Promise<void> {
  // Parse flags
  let batchSize = 50;
  let concurrency = 5;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--batch-size':
      case '-b':
        batchSize = parseInt(args[++i], 10);
        break;
      case '--concurrency':
      case '-c':
        concurrency = parseInt(args[++i], 10);
        break;
    }
  }

  const startTime = Date.now();
  const results = await runEncodePipeline({ batchSize, concurrency });
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  console.log(`\nEncode pipeline complete (${duration}s):`);
  console.log(`  Processed: ${results.length}`);
  console.log(`  Successful: ${successful.length}`);
  console.log(`  Failed: ${failed.length}`);
  console.log(`  Rate: ${(results.length / parseFloat(duration)).toFixed(1)} traces/sec`);

  if (failed.length > 0) {
    console.log('\nFailed encodes:');
    failed.forEach(f => console.log(`  - ${f.trace_id}: ${f.error}`));
  }
}

async function handleQuery(args: string[]): Promise<void> {
  const queryText = args.join(' ');
  
  if (!queryText) {
    console.error('Error: No query text provided.');
    process.exit(1);
  }

  console.log(`Searching for: "${queryText}"`);
  console.log('Generating embedding...');

  const embedding = await generateEmbedding(queryText);
  const results = semanticSearch(embedding, 10);

  console.log(`\nFound ${results.length} results:\n`);

  for (let i = 0; i < results.length; i++) {
    const { encode, distance } = results[i];
    console.log(`--- Result ${i + 1} (distance: ${distance.toFixed(4)}) ---`);
    console.log(`Summary: ${encode.semantic_summary}`);
    console.log(`Agent: ${encode.agent_id}`);
    console.log(`Topics: ${encode.topics.join(', ')}`);
    console.log(`Importance: ${encode.importance_score}`);
    console.log(`Emotional Valence: ${encode.emotional_valence}`);
    console.log(`Shared: ${encode.is_shared ? 'Yes' : 'No'}`);
    console.log();
  }
}

async function handleStatus(): Promise<void> {
  const totalTraces = getTraceCount();
  const pendingTraces = getTraceCountByStatus('pending');
  const encodedTraces = getTraceCountByStatus('encoded');
  const skippedTraces = getTraceCountByStatus('skipped');
  const totalEncodes = getEncodeCount();

  console.log('RECALL Status');
  console.log('=============');
  console.log();
  console.log(`Database: ${config.databasePath}`);
  console.log();
  console.log('Traces:');
  console.log(`  Total: ${totalTraces}`);
  console.log(`  Pending: ${pendingTraces}`);
  console.log(`  Encoded: ${encodedTraces}`);
  console.log(`  Skipped: ${skippedTraces}`);
  console.log();
  console.log('Encodes:');
  console.log(`  Total: ${totalEncodes}`);
}

function handleInit(): void {
  initDatabase();
  console.log('RECALL database initialized successfully.');
}

async function handleSweep(args: string[]): Promise<void> {
  // Parse flags
  let sinceHours = 24;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--since':
      case '-s':
        sinceHours = parseInt(args[++i], 10);
        break;
      case '--dry-run':
      case '-n':
        dryRun = true;
        break;
    }
  }

  const results = await sweepSessions({ sinceHours, dryRun });

  console.log(`\nSession sweep complete:`);
  console.log(`  Files scanned: ${results.filesScanned}`);
  console.log(`  Traces found: ${results.tracesFound}`);
  console.log(`  Traces created: ${results.tracesCreated}`);
  console.log(`  Duplicates skipped: ${results.duplicatesSkipped}`);

  if (dryRun) {
    console.log('\n  (Dry run - no traces were actually created)');
  }
}

async function handleBoot(args: string[]): Promise<void> {
  // Parse flags
  let agentId: string | null = null;
  let limit = 5;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--agent':
      case '-a':
        agentId = args[++i];
        break;
      case '--limit':
      case '-l':
        limit = parseInt(args[++i], 10);
        break;
    }
  }

  if (!agentId) {
    console.error('Error: --agent <id> is required');
    process.exit(1);
  }

  const startTime = Date.now();
  const encodes = getRecentEncodesForAgent(agentId, limit);
  const duration = Date.now() - startTime;

  console.log(`<!-- RECALL CONTEXT BLOCK (${duration}ms) -->`);
  console.log(`<context source="recall" agent="${agentId}" memories="${encodes.length}">`);
  console.log();

  for (let i = 0; i < encodes.length; i++) {
    const encode = encodes[i];
    console.log(`[${i + 1}] ${encode.semantic_summary}`);
    console.log(`    Topics: ${encode.topics.join(', ')}`);
    console.log(`    Importance: ${encode.importance_score.toFixed(2)} | Valence: ${encode.emotional_valence.toFixed(2)}`);
    console.log();
  }

  console.log('</context>');
}

function showHelp(): void {
  console.log(`
RECALL - Memory system for AI agents

Usage: recall <command> [options]

Commands:
  init                    Initialize the database
  trace [options]         Capture a new trace
    --agent, -a <id>      Agent ID (default: unknown)
    --session, -s <id>    Session ID (default: default)
    --channel, -c <name>  Channel (default: terminal)
    --type, -t <type>     Trace type: conversation|decision|task_completion|error|handoff
    --identity, -i        Mark as identity trace
    --participants, -p    Comma-separated list of participants
    --content <text>      Content (or pipe via stdin)
  encode [options]        Run encode pipeline on pending traces
    --batch-size, -b <n>  Number of traces to process (default: 50)
    --concurrency, -c <n> Concurrent processing limit (default: 5)
  sweep [options]         Sweep OpenClaw session files for traces
    --since, -s <hours>   Look back window in hours (default: 24)
    --dry-run, -n         Preview without creating traces
  boot [options]          Retrieve context for agent boot
    --agent, -a <id>      Agent ID (required)
    --limit, -l <n>       Number of memories (default: 5)
  query <text>            Search encodes by semantic similarity
  status                  Show database status

Environment:
  OPENAI_API_KEY          Required for embeddings and LLM features
  RECALL_DB_PATH          Custom database path (default: ~/.recall/recall.db)
  RECALL_EMBEDDING_MODEL  Embedding model (default: text-embedding-3-small)
  RECALL_LLM_MODEL        LLM model (default: gpt-4o-mini)
  RECALL_SWEEP_PATH       Path for session sweep (default: ~/.openclaw/workspace)
`);
}

main();
