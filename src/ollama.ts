/**
 * ollama.ts - Ollama client initialization utility
 *
 * Centralizes Ollama client configuration for all agent files.
 */

import { Ollama } from 'ollama';
import 'dotenv/config';
import { getConfig } from './config/index.js';

// Get configuration
const config = getConfig();

// Export configuration values from config
export const OLLAMA_HOST = config.llm.host;
export const OLLAMA_API_KEY = config.llm.apiKey;
export const MODEL = config.llm.model;

// Initialize Ollama client
export const ollama = new Ollama({
  host: OLLAMA_HOST,
  ...(OLLAMA_API_KEY ? { headers: { Authorization: `Bearer ${OLLAMA_API_KEY}` } } : {}),
});
