/**
 * prompts.ts - Prompt definitions and validation for setup wizard
 */

import { getDefaultEditor, getEditorHelpText } from './editor.js';

/**
 * Prompt configuration for a single environment variable
 */
export interface PromptConfig {
  name: string;
  message: string;
  default?: string;
  help?: string;
  sensitive?: boolean; // If true, value is redacted on display
  validate?: (value: string) => boolean | string;
  transform?: (value: string) => string;
}

/**
 * Validate URL format
 */
function validateUrl(url: string): boolean | string {
  try {
    new URL(url);
    return true;
  } catch {
    return 'Invalid URL format. Example: http://127.0.0.1:11434';
  }
}

/**
 * Validate positive number
 */
function validatePositiveNumber(value: string): boolean | string {
  const num = parseInt(value, 10);
  if (isNaN(num) || num <= 0) {
    return 'Must be a positive number';
  }
  return true;
}

/**
 * Prompt definitions for all environment variables
 */
export function getPrompts(): PromptConfig[] {
  return [
    {
      name: 'OLLAMA_HOST',
      message: 'Ollama server URL',
      default: 'http://127.0.0.1:11434',
      help: 'The URL of your Ollama server',
      validate: validateUrl,
    },
    {
      name: 'OLLAMA_MODEL',
      message: 'Ollama model name (general/chat)',
      default: 'glm-5:cloud',
      help: 'The model to use for general chat and coding tasks',
    },
    {
      name: 'OLLAMA_VISION_MODEL',
      message: 'Ollama vision model (for screen/image tools)',
      default: 'none',
      help: 'Set to "none" to disable vision features, or specify a vision-capable model (e.g., gemma4:31b-cloud)',
    },
    {
      name: 'OLLAMA_EMBEDDING_MODEL',
      message: 'Ollama embedding model (for semantic search/RAG)',
      default: '',
      help: 'Leave empty to skip, or specify an embedding model (e.g., nomic-embed-text)',
    },
    {
      name: 'OLLAMA_API_KEY',
      message: 'Ollama API key (optional, for cloud features)',
      default: '',
      help: 'Leave empty if using local Ollama',
      sensitive: true,
    },
    {
      name: 'TOKEN_THRESHOLD',
      message: 'Token threshold for context management',
      default: '50000',
      help: 'Context limit threshold for managing conversation size',
      validate: validatePositiveNumber,
    },
    {
      name: 'EDITOR',
      message: 'Text editor (for file editing)',
      default: getDefaultEditor(),
      help: getEditorHelpText(),
    },
  ];
}

/**
 * Environment variable requirements (for display purposes)
 */
export interface EnvRequirement {
  name: string;
  required: boolean;
  default?: string;
  instruction: string;
}

export const ENV_REQUIREMENTS: EnvRequirement[] = [
  {
    name: 'OLLAMA_HOST',
    required: false,
    default: 'http://127.0.0.1:11434',
    instruction: 'Set OLLAMA_HOST for your Ollama server',
  },
  {
    name: 'OLLAMA_MODEL',
    required: false,
    default: 'glm-5:cloud',
    instruction: 'Set OLLAMA_MODEL to specify which model to use',
  },
  {
    name: 'OLLAMA_VISION_MODEL',
    required: false,
    instruction: 'Set OLLAMA_VISION_MODEL for vision/multimodal tasks',
  },
  {
    name: 'OLLAMA_EMBEDDING_MODEL',
    required: false,
    instruction: 'Set OLLAMA_EMBEDDING_MODEL for semantic search/RAG',
  },
  {
    name: 'OLLAMA_API_KEY',
    required: false,
    instruction: 'Set OLLAMA_API_KEY for cloud/web search features',
  },
  {
    name: 'TOKEN_THRESHOLD',
    required: false,
    default: '50000',
    instruction: 'Set TOKEN_THRESHOLD for context limit',
  },
  {
    name: 'EDITOR',
    required: false,
    instruction: 'Set EDITOR for file editing (default varies by platform)',
  },
];