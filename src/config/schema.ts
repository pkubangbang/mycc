/**
 * Configuration schema - Type definitions for agent configuration
 */

/**
 * LLM-related configuration
 */
export interface LlmConfig {
  /** Ollama server URL */
  host: string;
  /** Default model name */
  model: string;
  /** API key for cloud models (optional) */
  apiKey?: string;
  /** Token threshold for auto-compacting */
  tokenThreshold: number;
  /** Character slice limit for conversation summarization */
  conversationSlice: number;
}

/**
 * Agent behavior configuration
 */
export interface AgentBehaviorConfig {
  /** Interval for todo nudging (in turns) */
  todoNudgeInterval: number;
  /** Agent version string */
  version: string;
}

/**
 * Timeout configuration (all in milliseconds)
 */
export interface TimeoutConfig {
  /** Maximum time for bash commands */
  bashCommand: number;
  /** Timeout for individual teammate */
  teammateAwait: number;
  /** Timeout for entire team */
  teamAwait: number;
}

/**
 * Storage paths configuration
 */
export interface StorageConfig {
  /** Data directory name (e.g., '.mycc') */
  dataDir: string;
  /** Database filename */
  dbName: string;
  /** Mail subdirectory name */
  mailDir: string;
  /** Tools subdirectory name */
  toolsDir: string;
  /** Skills subdirectory name */
  skillsDir: string;
  /** Transcripts subdirectory name */
  transcriptsDir: string;
}

/**
 * Tool-specific configuration
 */
export interface ToolConfig {
  /** Maximum buffer size for bash output (bytes) */
  bashMaxBuffer: number;
  /** Maximum characters to return from bash output */
  bashOutputLimit: number;
  /** Commands that are blocked from execution */
  dangerousCommands: string[];
  /** Tools restricted to main scope only */
  mainOnlyTools: string[];
}

/**
 * System prompt templates
 */
export interface PromptTemplates {
  /** Prompt lines for lead agent with team */
  leadWithTeam: string[];
  /** Prompt lines for solo lead agent */
  leadSolo: string[];
  /** Prompt lines for child agents */
  childAgent: string[];
}

/**
 * Complete agent configuration
 */
export interface AgentConfig {
  /** LLM configuration */
  llm: LlmConfig;
  /** Agent behavior configuration */
  agent: AgentBehaviorConfig;
  /** Timeout configuration */
  timeouts: TimeoutConfig;
  /** Storage paths */
  storage: StorageConfig;
  /** Tool configuration */
  tools: ToolConfig;
  /** System prompt templates */
  prompts: PromptTemplates;
}