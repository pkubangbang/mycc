/**
 * prompts.ts - Prompt definitions and validation for setup wizard
 *
 * Supports both Ollama and DeepSeek providers. The API_PROVIDER choice
 * determines which set of prompts is shown to the user.
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
 * Get Ollama connection prompts (common to all providers)
 */
function getOllamaConnectionPrompts(): PromptConfig[] {
  return [
    {
      name: 'OLLAMA_HOST',
      message: 'Ollama server URL',
      default: 'http://127.0.0.1:11434',
      help: 'The URL of your Ollama server (used for embeddings)',
      validate: validateUrl,
    },
    {
      name: 'OLLAMA_EMBEDDING_MODEL',
      message: 'Ollama embedding model (for semantic search/RAG)',
      default: 'nomic-embed-text',
      help: 'An embedding model is recommended for wiki/RAG features. Leave empty to skip.',
    },
  ];
}

/**
 * Get Ollama-specific prompts (after connection setup)
 */
function getOllamaPrompts(): PromptConfig[] {
  return [
    {
      name: 'OLLAMA_API_KEY',
      message: 'Ollama API key (optional, for cloud features)',
      default: '',
      help: 'Set if using Ollama cloud features. Leave empty for local Ollama.',
      sensitive: true,
    },
    {
      name: 'OLLAMA_MODEL',
      message: 'Ollama model name (general/chat)',
      default: 'glm-5:cloud',
      help: 'The model to use for general chat and coding tasks.',
    },
    {
      name: 'OLLAMA_VISION_MODEL',
      message: 'Ollama vision model (for screen/image tools)',
      default: 'none',
      help: 'Set to "none" to disable vision features, or specify a vision-capable model.',
    },
  ];
}

/**
 * Get DeepSeek-specific prompts
 */
function getDeepSeekPrompts(): PromptConfig[] {
  return [
    {
      name: 'DEEPSEEK_HOST',
      message: 'DeepSeek API host URL',
      default: 'https://api.deepseek.com',
      help: 'The DeepSeek API endpoint. Change only if using a proxy or compatible API.',
      validate: validateUrl,
    },
    {
      name: 'DEEPSEEK_API_KEY',
      message: 'DeepSeek API key',
      default: '',
      help: 'Required. Get yours at https://platform.deepseek.com/api_keys',
      sensitive: true,
    },
    {
      name: 'DEEPSEEK_MODEL',
      message: 'DeepSeek model name',
      default: 'deepseek-chat',
      help: 'The DeepSeek model to use (e.g., deepseek-chat, deepseek-reasoner)',
    },
  ];
}

/**
 * Get shared prompts (always asked regardless of provider)
 */
function getSharedPrompts(): PromptConfig[] {
  return [
    {
      name: 'OLLAMA_EMBEDDING_MODEL',
      message: 'Ollama embedding model (for semantic search/RAG, always uses Ollama)',
      default: '',
      help: 'An embedding model is recommended for wiki/RAG features (e.g., nomic-embed-text). Leave empty to skip.',
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
 * Get prompts based on the selected provider
 */
export function getPrompts(provider?: 'ollama' | 'deepseek'): PromptConfig[] {
  const providerPrompts = provider === 'deepseek' ? getDeepSeekPrompts() : getOllamaPrompts();
  return [
    ...getOllamaConnectionPrompts(),
    ...providerPrompts,
    ...getSharedPrompts(),
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
  // Ollama connection (common to all providers)
  {
    name: 'OLLAMA_HOST',
    required: false,
    default: 'http://127.0.0.1:11434',
    instruction: 'Set OLLAMA_HOST for your Ollama server (used for embeddings)',
  },
  {
    name: 'OLLAMA_EMBEDDING_MODEL',
    required: false,
    instruction: 'Set OLLAMA_EMBEDDING_MODEL for semantic search/RAG (always uses Ollama)',
  },
  // Provider selection
  {
    name: 'API_PROVIDER',
    required: false,
    default: 'ollama',
    instruction: 'Set API_PROVIDER to "deepseek" to use DeepSeek instead of Ollama',
  },
  // Ollama vars
  {
    name: 'OLLAMA_API_KEY',
    required: false,
    instruction: 'Set OLLAMA_API_KEY for cloud features',
  },
  {
    name: 'OLLAMA_MODEL',
    required: false,
    default: 'glm-5:cloud',
    instruction: 'Set OLLAMA_MODEL for chat model',
  },
  {
    name: 'OLLAMA_VISION_MODEL',
    required: false,
    instruction: 'Set OLLAMA_VISION_MODEL for vision/multimodal tasks',
  },
  // DeepSeek vars
  {
    name: 'DEEPSEEK_HOST',
    required: false,
    default: 'https://api.deepseek.com',
    instruction: 'Set DEEPSEEK_HOST for your DeepSeek API endpoint',
  },
  {
    name: 'DEEPSEEK_API_KEY',
    required: false,
    instruction: 'Set DEEPSEEK_API_KEY for DeepSeek API access',
  },
  {
    name: 'DEEPSEEK_MODEL',
    required: false,
    default: 'deepseek-chat',
    instruction: 'Set DEEPSEEK_MODEL to specify which DeepSeek model to use',
  },
  // Shared vars
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
