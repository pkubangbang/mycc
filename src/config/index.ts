/**
 * Config module - Centralized configuration management
 * 
 * Priority order (highest to lowest):
 * 1. Environment variables
 * 2. Config file (TODO)
 * 3. Default values
 */

import type { AgentConfig } from './schema.js';
import { defaultConfig } from './defaults.js';

let config: AgentConfig | null = null;

/**
 * Get the current configuration, loading it if necessary
 */
export function getConfig(): AgentConfig {
  if (!config) {
    config = loadConfig();
  }
  return config;
}

/**
 * Load configuration from environment and defaults
 */
function loadConfig(): AgentConfig {
  const cfg = { ...defaultConfig };
  
  // LLM configuration from environment
  cfg.llm.host = process.env.OLLAMA_HOST || cfg.llm.host;
  cfg.llm.model = process.env.OLLAMA_MODEL || cfg.llm.model;
  cfg.llm.apiKey = process.env.OLLAMA_API_KEY || cfg.llm.apiKey;
  
  // Timeouts from environment (convert to milliseconds)
  if (process.env.MYCC_BASH_TIMEOUT) {
    cfg.timeouts.bashCommand = parseInt(process.env.MYCC_BASH_TIMEOUT, 10);
  }
  if (process.env.MYCC_TEAM_TIMEOUT) {
    cfg.timeouts.teamAwait = parseInt(process.env.MYCC_TEAM_TIMEOUT, 10);
  }
  
  // Token limits from environment
  if (process.env.MYCC_TOKEN_THRESHOLD) {
    cfg.llm.tokenThreshold = parseInt(process.env.MYCC_TOKEN_THRESHOLD, 10);
  }
  
  // Storage paths from environment
  if (process.env.MYCC_DATA_DIR) {
    cfg.storage.dataDir = process.env.MYCC_DATA_DIR;
  }
  
  return cfg;
}

/**
 * Reset configuration (useful for testing)
 */
export function resetConfig(): void {
  config = null;
}

/**
 * Set configuration directly (useful for testing)
 */
export function setConfig(newConfig: AgentConfig): void {
  config = newConfig;
}

export { defaultConfig } from './defaults.js';
export type { AgentConfig } from './schema.js';