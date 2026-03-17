import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync } from 'fs';

export interface Config {
  databasePath: string;
  openaiApiKey: string;
  embeddingModel: string;
  llmModel: string;
  // Anthropic OAuth for analysis (optional — falls back to OpenAI if not set)
  anthropicApiKey: string | null;
  anthropicModel: string;
}

function getDatabasePath(): string {
  const customPath = process.env.RECALL_DB_PATH;
  if (customPath) return customPath;
  
  const defaultDir = join(homedir(), '.recall');
  try {
    mkdirSync(defaultDir, { recursive: true });
  } catch (e) {
    // Directory may already exist
  }
  return join(defaultDir, 'recall.db');
}

export function loadConfig(): Config {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY environment variable is required');
  }

  return {
    databasePath: getDatabasePath(),
    openaiApiKey: apiKey,
    embeddingModel: process.env.RECALL_EMBEDDING_MODEL || 'text-embedding-3-small',
    llmModel: process.env.RECALL_LLM_MODEL || 'gpt-4o-mini',
    // Anthropic OAuth for analysis (Haiku 4.5 via Pro sub — zero cost)
    anthropicApiKey: process.env.ANTHROPIC_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY || null,
    anthropicModel: process.env.RECALL_ANTHROPIC_MODEL || 'claude-haiku-4-5',
  };
}

export const config = loadConfig();
