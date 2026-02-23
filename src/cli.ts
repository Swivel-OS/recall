#!/usr/bin/env node

import { initDatabase } from './db/init.js';
import { captureTrace } from './trace/capture.js';
import { runEncodePipeline } from './encode/pipeline.js';
import { getTraceCount, getTraceCountByStatus } from './db/traces.js';
import { getEncodeCount, semanticSearch } from './db/encodes.js';
import { generateEmbedding } from './encode/pipeline.js';
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
        await handleEncode();
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

async function handleEncode(): Promise<void> {
  const results = await runEncodePipeline();
  
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  console.log(`\nEncode pipeline complete:`);
  console.log(`  Processed: ${results.length}`);
  console.log(`  Successful: ${successful.length}`);
  console.log(`  Failed: ${failed.length}`);

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
  encode                  Run encode pipeline on pending traces
  query <text>            Search encodes by semantic similarity
  status                  Show database status

Environment:
  OPENAI_API_KEY          Required for embeddings and LLM features
  RECALL_DB_PATH          Custom database path (default: ~/.recall/recall.db)
  RECALL_EMBEDDING_MODEL  Embedding model (default: text-embedding-3-small)
  RECALL_LLM_MODEL        LLM model (default: gpt-4o-mini)
`);
}

main();
