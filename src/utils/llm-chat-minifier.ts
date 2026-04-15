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
  return text.slice(0, maxLen - 20) + '...' + text.slice(-17);
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
  return compact.length <= maxLen ? compact : compact.slice(0, maxLen - 3) + '...';
}