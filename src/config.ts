import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync } from 'fs';

export interface Config {
  databasePath: string;
  openaiApiKey: string;
  embeddingModel: string;
  llmModel: string;
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
    llmModel: process.env.RECALL_LLM_MODEL || 'gpt-4o-mini'
  };
}

export const config = loadConfig();
