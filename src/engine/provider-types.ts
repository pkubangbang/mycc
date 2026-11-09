/**
 * provider-types.ts - Provider-neutral chat and web contracts.
 *
 * These types describe mycc's engine boundary, not a vendor SDK. Ollama and
 * DeepSeek adapters translate their wire formats into these shared shapes.
 */

export interface ProviderToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface ProviderMessage {
  role: string;
  content: string;
  thinking?: string;
  reasoning_content?: string;
  images?: Array<string | Uint8Array>;
  tool_calls?: ProviderToolCall[];
  tool_name?: string;
}

export interface ProviderTool {
  type: string;
  function: {
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ChatRequest {
  model: string;
  messages?: ProviderMessage[];
  stream?: boolean;
  format?: string | object;
  keep_alive?: string;
  tools?: ProviderTool[];
  /** Tool choice: 'none' | 'auto' | 'required' (or provider-specific string). */
  tool_choice?: string;
  think?: boolean | 'high' | 'medium' | 'low';
  options?: Record<string, unknown>;
}

export interface ChatResponse {
  model: string;
  created_at: Date;
  message: ProviderMessage;
  done: boolean;
  done_reason: string;
  total_duration: number;
  load_duration: number;
  prompt_eval_count: number;
  prompt_eval_duration: number;
  eval_count: number;
  eval_duration: number;
}

export interface WebSearchResult {
  content: string;
  title?: string;
  url?: string;
}

export interface WebSearchResponse {
  results: WebSearchResult[];
}

export interface WebFetchResponse {
  title: string;
  url: string;
  content: string;
  links: string[];
}

export type Tool = ProviderTool;

export interface EmbedRequest {
  model: string;
  input: string | string[];
}

export interface EmbedResponse {
  embeddings: number[][];
}

export interface ModelInfo {
  model_info?: Record<string, unknown>;
  details?: {
    family?: string;
    parameter_size?: string;
  };
}

export interface ModelListResponse {
  models: Array<Record<string, unknown>>;
}
