/**
 * llm-chat-minifier.ts - Compact message format for LLM summary/extraction
 *
 * Converts Message[] to a token-efficient text format:
 * - System messages omitted
 * - Two-letter role abbreviations (ux, ax, ti, to)
 * - Pipe separator for minimal overhead
 * - Tool results included in full (no truncation)
 */

import type { Message } from '../types.js';

export interface MinifierOptions {
  /** Max length for user/assistant content before truncation (default: 500) */
  maxContentLength?: number;
  /** Max length for tool call arguments (default: 200) */
  maxArgsLength?: number;
}

const ROLE_ABBREVS: Record<string, string> = {
  user: 'ux',
  assistant: 'ax',
  tool: 'to',
};

/**
 * Format messages into compact text for LLM processing
 *
 * Example output:
 * ```
 * > ux = user, ax = assistant, ti = tool call, to = tool result
 * ux|hello
 * ax|hi
 * ux|what's inside the folder?
 * ti|bash|command=ls -al, timeout=0
 * to|bash|file1.txt
 * file2.md
 * ...
 * ax|there are 5 markdown files...
 * ```
 */
export function minifyMessages(
  messages: Message[],
  options: MinifierOptions = {}
): string {
  const { maxContentLength = 500, maxArgsLength = 200 } = options;

  const lines: string[] = [
    '> ux = user, ax = assistant, ti = tool call, to = tool result'
  ];

  for (const msg of messages) {
    // Skip system messages
    if (msg.role === 'system') continue;

    // Handle assistant with tool_calls as 'ti' (tool invocation)
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        const args = truncateArgs(tc.function.arguments, maxArgsLength);
        lines.push(`ti|${tc.function.name}|${args}`);
      }
      // Also include text content if present
      if (msg.content?.trim()) {
        lines.push(`ax|${truncate(msg.content, maxContentLength)}`);
      }
      continue;
    }

    // Handle tool result - included in full, no truncation
    if (msg.role === 'tool') {
      lines.push(`to|${msg.tool_name || 'unknown'}|${msg.content || ''}`);
      continue;
    }

    // Regular user/assistant messages
    const abbrev = ROLE_ABBREVS[msg.role] || msg.role;
    lines.push(`${abbrev}|${truncate(msg.content || '', maxContentLength)}`);
  }

  return lines.join('\n');
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 20)  }...${  text.slice(-17)}`;
}

function truncateArgs(args: Record<string, unknown>, maxLen: number): string {
  const str = JSON.stringify(args);
  if (str.length <= maxLen) return str;
  // Keep keys, truncate values
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    const valStr = typeof value === 'string' && value.length > 50
      ? `"${value.slice(0, 20)}...${value.slice(-10)}"`
      : JSON.stringify(value);
    parts.push(`${key}:${valStr}`);
  }
  const compact = `{${parts.join(',')}}`;
  return compact.length <= maxLen ? compact : `${compact.slice(0, maxLen - 3)  }...`;
}

// ============================================================================
// Hint Context Extraction
// ============================================================================

/** Summary of a tool call for hint context */
export interface ToolCallSummary {
  name: string;
  args?: string;
  status: 'success' | 'error' | 'pending';
}

/** Summary of an error for hint context */
export interface ErrorSummary {
  tool: string;
  error: string;
}

/** Repetition pattern for hint context */
export interface RepetitionPattern {
  tool: string;
  count: number;
}

/** Context extracted for hint generation */
export interface HintContext {
  userIntent: string;
  recentTools: ToolCallSummary[];
  errors: ErrorSummary[];
  repetition: RepetitionPattern[];
  confusionScore: number;
  confusionBreakdown: string;
}

// Regex to filter out todo nudging and other system messages
const TODO_NUDGE_REGEX = /<reminder>Update your todos/;
const SYSTEM_MESSAGE_REGEX = /^(\[HINT\]|\[URGENT:|Continue with your task)/;

/** Check if a tool result string indicates an error */
function isErrorResult(result: string): boolean {
  if (!result) return false;
  const lower = result.toLowerCase();
  // Common error prefixes
  if (lower.startsWith('error:') || lower.startsWith('error ') || lower.startsWith('fatal:')) return true;
  // Shell exit codes
  if (/command failed with exit code \d+/.test(lower)) return true;
  // Node.js error patterns
  if (lower.includes('eacces') || lower.includes('enoent') || lower.includes('eperm')) return true;
  // Permission denied
  if (lower.includes('permission denied')) return true;
  // Not found / does not exist
  if (lower.includes('not found') || lower.includes('does not exist') || lower.includes('no such file')) return true;
  return false;
}

/**
 * Extract focused context for hint generation
 * Filters out noise and focuses on progress tracking
 */
export function minifyForHint(
  messages: Message[],
  confusionScore: number,
  confusionBreakdown: string
): HintContext {
  // 1. Extract user intent from first user message
  let userIntent = '(no user intent found)';
  for (const msg of messages) {
    if (msg.role === 'user' && msg.content && !SYSTEM_MESSAGE_REGEX.test(msg.content)) {
      userIntent = truncate(msg.content, 300);
      break;
    }
  }

  // 2. Filter messages and extract tool calls
  const filteredMessages = messages.filter(msg => {
    if (msg.role === 'system') return false;
    if (msg.role === 'user' && TODO_NUDGE_REGEX.test(msg.content || '')) return false;
    if (msg.role === 'user' && SYSTEM_MESSAGE_REGEX.test(msg.content || '')) return false;
    return true;
  });

  // 3. Summarize recent tool calls (last 10)
  const recentTools: ToolCallSummary[] = [];
  const toolCallCounts = new Map<string, number>();
  const errors: ErrorSummary[] = [];

  // Process messages in reverse to get most recent first
  for (let i = filteredMessages.length - 1; i >= 0 && recentTools.length < 10; i--) {
    const msg = filteredMessages[i];

    // Track tool calls
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        const name = tc.function.name;
        // Count for repetition detection
        toolCallCounts.set(name, (toolCallCounts.get(name) || 0) + 1);

        recentTools.unshift({
          name,
          args: truncateArgs(tc.function.arguments, 100),
          status: 'pending',
        });
      }
    }

    // Track tool results and their status
    if (msg.role === 'tool') {
      const status = isErrorResult(msg.content || '') ? 'error' : 'success';
      // Update the most recent matching tool call
      for (let j = recentTools.length - 1; j >= 0; j--) {
        if (recentTools[j].name === msg.tool_name && recentTools[j].status === 'pending') {
          recentTools[j].status = status;
          break;
        }
      }
      // Track errors
      if (status === 'error') {
        errors.push({
          tool: msg.tool_name || 'unknown',
          error: truncate(msg.content || 'unknown error', 100),
        });
      }
    }
  }

  // 4. Detect repetition patterns (tools called 3+ times)
  const repetition: RepetitionPattern[] = [];
  for (const [tool, count] of toolCallCounts) {
    if (count >= 3) {
      repetition.push({ tool, count });
    }
  }

  return {
    userIntent,
    recentTools,
    errors: errors.slice(-5), // Keep last 5 errors
    repetition,
    confusionScore,
    confusionBreakdown,
  };
}