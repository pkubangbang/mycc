/**
 * prompts.ts - Prompt definitions and validation for setup wizard
 *
 * Supports both Ollama and DeepSeek providers. The API_PROVIDER choice
 * determines which set of prompts is shown to the user.
 */

import { getDefaultEditor, getEditorHelpText, validateEditor } from './editor.js';

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
  /** Dynamic help text based on current config (e.g., host-aware API key help) */
  dynamicHelp?: (config: Record<string, string>) => string;
}

/**
 * Parse a URL, returning true or an error string supplied by the caller.
 * Keeps the parsing logic in one place; only the guidance differs per provider.
 */
function parseUrl(url: string, onError: string): boolean | string {
  try {
    new URL(url);
    return true;
  } catch {
    return onError;
  }
}

/**
 * Validate Ollama host URL with helpful examples
 */
function validateOllamaHost(url: string): boolean | string {
  return parseUrl(url, 'Invalid URL. Examples:\n  Local: http://127.0.0.1:11434\n  Cloud: https://ollama.com');
}

/**
 * Validate DeepSeek host URL with helpful example
 */
function validateDeepSeekHost(url: string): boolean | string {
  return parseUrl(url, 'Invalid URL. Example: https://api.deepseek.com');
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
      help: 'URL of Ollama server. Local: http://127.0.0.1:11434 (default). Cloud: https://ollama.com',
      validate: validateOllamaHost
    },
    {
      name: 'OLLAMA_EMBEDDING_MODEL',
      message: 'Ollama embedding model (for semantic search/RAG)',
      default: 'nomic-embed-text',
      help: 'Embedding model for wiki/RAG. Options: nomic-embed-text (default), embeddinggemma (needs Ollama v0.11.10+, applies prompt prefixes automatically).'
    }
  ];
}

/**
 * Get Ollama-specific prompts (after connection setup)
 */
function getOllamaPrompts(): PromptConfig[] {
  return [
    {
      name: 'OLLAMA_API_KEY',
      message: 'Ollama API key (optional)',
      default: '',
      help: 'Required for cloud-backed models. Web tools use OLLAMA_HOST; their backend determines authentication.',
      sensitive: true,
      dynamicHelp: (config: Record<string, string>) => {
        const host = config['OLLAMA_HOST'] || 'http://127.0.0.1:11434';
        if (host.includes('127.0.0.1') || host.includes('localhost')) {
          return 'Local-only models need no key. For :cloud models routed by local Ollama, use ollama signin. Web backend authentication is server-side.';
        }
        return 'Required for Ollama Cloud. Get your key at https://ollama.com/settings/keys';
      }
    },
    {
      name: 'OLLAMA_MODEL',
      message: 'Ollama model name (general/chat)',
      default: 'llama3.1',
      help: 'Model for chat/coding. Local: llama3.1, qwen2.5-coder. Cloud: glm-5:cloud, gemma4:31b-cloud'
    },
    {
      name: 'OLLAMA_VISION_MODEL',
      message: 'Ollama vision model (for screen/image tools)',
      default: 'none',
      help: 'Vision model for screen/image analysis. Set "none" to disable. Requires Ollama Cloud or local vision model.'
    }
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
      validate: validateDeepSeekHost
    },
    {
      name: 'DEEPSEEK_API_KEY',
      message: 'DeepSeek API key',
      default: '',
      help: 'Required. Get yours at https://platform.deepseek.com/api_keys',
      sensitive: true
    },
    {
      name: 'DEEPSEEK_MODEL',
      message: 'DeepSeek model name',
      default: 'deepseek-chat',
      help: 'The DeepSeek model to use (e.g., deepseek-chat, deepseek-reasoner)'
    },
    {
      name: 'DEEPSEEK_VISION_MODEL',
      message: 'DeepSeek vision model (for screen/image tools)',
      default: 'deepseek-flash',
      help: 'Set to "none" to disable vision features, or specify a vision-capable model (default: deepseek-flash).'
    }
  ];
}

/**
 * Get shared prompts (always asked regardless of provider)
 */
function getSharedPrompts(): PromptConfig[] {
  return [
    {
      name: 'TOKEN_THRESHOLD',
      message: 'Token threshold for context management',
      default: '100000',
      help: 'Max conversation tokens before auto-compaction. Higher = longer memory but slower. Default: 100000',
      validate: validatePositiveNumber
    },
    {
      name: 'EDITOR',
      message: 'Text editor (for file editing)',
      default: getDefaultEditor(),
      help: getEditorHelpText(),
      validate: validateEditor
    }
  ];
}

/**
 * Get prompts based on the selected provider
 */
export function getPrompts(provider?: 'ollama' | 'deepseek'): PromptConfig[] {
  const providerPrompts = provider === 'deepseek' ? getDeepSeekPrompts() : getOllamaPrompts();
  return [...getOllamaConnectionPrompts(), ...providerPrompts, ...getSharedPrompts()];
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
    instruction: 'Set OLLAMA_HOST for your Ollama server (used for embeddings)'
  },
  {
    name: 'OLLAMA_EMBEDDING_MODEL',
    required: false,
    instruction: 'Set OLLAMA_EMBEDDING_MODEL for semantic search/RAG (always uses Ollama)'
  },
  // Provider selection
  {
    name: 'API_PROVIDER',
    required: false,
    default: 'ollama',
    instruction: 'Set API_PROVIDER to "deepseek" to use DeepSeek instead of Ollama'
  },
  // Ollama vars
  {
    name: 'OLLAMA_API_KEY',
    required: false,
    instruction:
      'Set OLLAMA_API_KEY for cloud-backed models (not needed for local-only chat/vision; web backend auth is server-side)'
  },
  {
    name: 'OLLAMA_MODEL',
    required: false,
    default: 'glm-5:cloud',
    instruction: 'Set OLLAMA_MODEL for chat model'
  },
  {
    name: 'OLLAMA_VISION_MODEL',
    required: false,
    instruction: 'Set OLLAMA_VISION_MODEL for vision/multimodal tasks'
  },
  // DeepSeek vars
  {
    name: 'DEEPSEEK_HOST',
    required: false,
    default: 'https://api.deepseek.com',
    instruction: 'Set DEEPSEEK_HOST for your DeepSeek API endpoint'
  },
  {
    name: 'DEEPSEEK_API_KEY',
    required: false,
    instruction: 'Set DEEPSEEK_API_KEY for DeepSeek API access'
  },
  {
    name: 'DEEPSEEK_MODEL',
    required: false,
    default: 'deepseek-chat',
    instruction: 'Set DEEPSEEK_MODEL to specify which DeepSeek model to use'
  },
  {
    name: 'DEEPSEEK_VISION_MODEL',
    required: false,
    default: 'deepseek-flash',
    instruction: 'Set DEEPSEEK_VISION_MODEL for vision/multimodal tasks (default: deepseek-flash)'
  },
  // Shared vars
  {
    name: 'TOKEN_THRESHOLD',
    required: false,
    default: '100000',
    instruction: 'Set TOKEN_THRESHOLD for context limit'
  },
  {
    name: 'EDITOR',
    required: false,
    instruction: 'Set EDITOR for file editing (default varies by platform)'
  }
];
