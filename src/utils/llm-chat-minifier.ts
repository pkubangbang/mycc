/**
 * llm-chat-minifier.ts - Compact message format for LLM summary/extraction
 *
 * Converts Message[] to a token-efficient text format:
 * - System messages omitted
 * - Two-letter role abbreviations (ux, ax, ti, to)
 * - Pipe separator for minimal overhead
 * - Tool results optionally truncated (controlled by truncateToolOutput)
 */

import type { Message } from '../types.js';

interface MinifierOptions {
  /** Max length for user/assistant content before truncation (default: 500) */
  maxContentLength?: number;
  /** Max length for tool call arguments (default: 200) */
  maxArgsLength?: number;
  /** Whether to truncate tool result content as well (default: false) */
  truncateToolOutput?: boolean;
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
  const { maxContentLength = 500, maxArgsLength = 200, truncateToolOutput = false } = options;

  const lines: string[] = [
    '> ux = user, ax = assistant, ti = tool call, to = tool result',
    '> [name] suffix = hook-injected (ux[name] = hook note, ti[name] = hook tool call)'
  ];

  for (const msg of messages) {
    // Skip system messages
    if (msg.role === 'system') continue;

    // Handle assistant with tool_calls as 'ti' (tool invocation)
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        const args = truncateArgs(tc.function.arguments, maxArgsLength);
        // Hook-injected calls use IDs of the form `hook-${skillName}-${timestamp}`.
        // Surface the hook skill name so downstream consumers (hint round) can
        // attribute tool calls to hookish skills rather than the agent.
        // Note: Ollama's ToolCall type lacks `id`, but mycc's extended ToolCall
        // (src/types.ts) adds it; tool_calls populated by the triologue carry it.
        const hookName = extractHookName((tc as { id?: string }).id);
        lines.push(hookName
          ? `ti[${hookName}]|${tc.function.name}|${args}`
          : `ti|${tc.function.name}|${args}`);
      }
      // Also include text content if present
      if (msg.content?.trim()) {
        lines.push(`ax|${truncate(msg.content, maxContentLength)}`);
      }
      continue;
    }

    // Handle tool result - truncated if truncateToolOutput is true
    if (msg.role === 'tool') {
      const content = truncateToolOutput
        ? truncate(msg.content || '', maxContentLength)
        : (msg.content || '');
      lines.push(`to|${msg.tool_name || 'unknown'}|${content}`);
      continue;
    }

    // Regular user/assistant messages.
    // Hook-injected user-role notes carry hook_name metadata; surface it as
    // `ux[hookName]|` (parallel to `ti[hookName]|` for hook tool calls) so
    // downstream consumers (hint round) can attribute notes to their hook.
    const abbrev = ROLE_ABBREVS[msg.role] || msg.role;
    const hookName = (msg as { hook_name?: string }).hook_name;
    lines.push(hookName
      ? `${abbrev}[${hookName}]|${truncate(msg.content || '', maxContentLength)}`
      : `${abbrev}|${truncate(msg.content || '', maxContentLength)}`);
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

/**
 * Extract the hookish skill name from a tool call ID.
 * Hook-injected calls use IDs of the form `hook-${skillName}-${timestamp}`.
 * Returns the skill name, or null if the ID is not a hook-originated call.
 * The non-greedy `(.+?)` allows skill names containing hyphens (e.g.
 * `lint-after-edit`) by expanding until the trailing `-timestamp` anchors.
 */
function extractHookName(id?: string): string | null {
  if (!id) return null;
  const m = id.match(/^hook-(.+?)-\d+$/);
  return m ? m[1] : null;
}

// Note: isErrorResult is intentionally not placed here — it has platform-specific
// copies in src/loop/states/tool.ts and src/context/teammate-worker.ts where it's used.