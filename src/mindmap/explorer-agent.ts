/**
 * explorer-agent.ts - Autonomous code exploration for mindmap summarization
 *
 * This agent uses a loop pattern similar to teammate-worker to explore
 * the codebase and generate enriched summaries for mindmap nodes.
 *
 * Tools available:
 * - read_file: Read file contents
 * - ls: List directory contents
 * - grep: Search file contents
 * - mark_file: Mark a file as related to the topic
 * - web_search: Search the web for information
 * - web_fetch: Fetch content from a URL
 */

import { ollama, MODEL } from '../ollama.js';
import type { Message, Tool, ToolCall } from '../types.js';
import type { WebFetchResponse } from 'ollama';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { minifyMessages } from '../utils/llm-chat-minifier.js';
import { getTokenThreshold, getMyccDir, ensureDirs } from '../config.js';

/**
 * Configuration constants
 */
const MAX_ROUNDS_DEFAULT = 50;
const WEB_TIMEOUT_MS = 30000; // 30 seconds timeout for web operations
const TOKEN_THRESHOLD = getTokenThreshold();

/**
 * Result of exploration - summary and marked files/URLs
 */
export interface ExplorationResult {
  summary: string;
  markedFiles: string[];
  markedUrls: string[];
}

/**
 * Estimate token count for messages (word-based approximation)
 */
function estimateTokens(messages: Message[]): number {
  let count = 0;
  for (const msg of messages) {
    if (msg.content) {
      count += msg.content.split(/\s+/).length;
    }
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        count += JSON.stringify(tc.function.arguments).split(/\s+/).length;
      }
    }
  }
  return count;
}

/**
 * Compact messages by summarizing with LLM
 * Saves transcript to disk and returns summarized messages
 */
async function compactMessages(
  messages: Message[],
  nodeTitle: string
): Promise<Message[]> {
  // Ensure transcript directory exists
  ensureDirs();
  const transcriptDir = path.join(getMyccDir(), 'transcripts');
  if (!fs.existsSync(transcriptDir)) {
    fs.mkdirSync(transcriptDir, { recursive: true });
  }

  // Save full transcript to disk
  const timestamp = Math.floor(Date.now() / 1000);
  const transcriptPath = path.join(transcriptDir, `explorer_${timestamp}.jsonl`);

  const writeStream = fs.createWriteStream(transcriptPath);
  for (const msg of messages) {
    writeStream.write(`${JSON.stringify(msg)}\n`);
  }
  writeStream.end();

  // Build conversation text for summarization
  const conversationText = minifyMessages(messages);

  const response = await ollama.chat({
    model: MODEL,
    messages: [
      {
        role: 'user',
        content:
          `Summarize this exploration session for continuity. Include:\n` +
          `1) What was discovered\n` +
          `2) Current progress\n` +
          `3) Key findings so far\n` +
          `4) Files/URLs marked as relevant\n\n` +
          `Context: Exploring section "${nodeTitle}"\n\n` +
          `${conversationText}`,
      },
    ],
  });

  const summary = response.message.content || '(no summary)';

  // Return compacted messages: summary + acknowledgment
  return [
    {
      role: 'user',
      content: `[Conversation compressed. Transcript: ${transcriptPath}]\n\n${summary}`,
    },
    {
      role: 'assistant',
      content: 'Understood. I have the context from the summary. Continuing exploration.',
    },
  ];
}

/**
 * Tools for exploration (defined inline, no external dependencies)
 */
const EXPLORER_TOOLS: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read file contents. Use to understand code implementations.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File path relative to workDir',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ls',
      description: 'List directory contents. Use to discover file structure.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Directory path (default: current)',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search for pattern in files. Use to find relevant code.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Search pattern (regex)',
          },
          path: {
            type: 'string',
            description: 'Directory to search (default: .)',
          },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mark_file',
      description:
        'Mark a file as relevant to the current topic. Call this when you find a file that contains important code related to the section.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File path to mark as relevant',
          },
          reason: {
            type: 'string',
            description: 'Why this file is relevant (brief)',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the web for information. Use for documentation, libraries, or external resources.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description:
        'Fetch content from a URL. Use to read documentation or articles found via web_search.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to fetch',
          },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mark_url',
      description:
        'Mark a URL as relevant to the current topic. Call this when you find a web resource that contains important information related to the section.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'URL to mark as relevant',
          },
          reason: {
            type: 'string',
            description: 'Why this URL is relevant (brief)',
          },
        },
        required: ['url'],
      },
    },
  },
];

/**
 * Execute a tool call
 * @returns Tool output string
 * @param markedFiles - Set to track marked files (passed by reference)
 * @param markedUrls - Set to track marked URLs (passed by reference)
 */
async function executeTool(
  name: string,
  args: Record<string, unknown>,
  workDir: string,
  markedFiles: Set<string>,
  markedUrls: Set<string>
): Promise<string> {
  switch (name) {
    case 'read_file':
      return readFile(args.path as string, workDir);
    case 'ls':
      return ls(args.path as string | undefined, workDir);
    case 'grep':
      return grep(
        args.pattern as string,
        args.path as string | undefined,
        workDir
      );
    case 'mark_file':
      return markFile(
        args.path as string,
        args.reason as string | undefined,
        workDir,
        markedFiles
      );
    case 'web_search':
      return await webSearch(args.query as string);
    case 'web_fetch':
      return await webFetch(args.url as string);
    case 'mark_url':
      return markUrl(
        args.url as string,
        args.reason as string | undefined,
        markedUrls
      );
    default:
      return `Unknown tool: ${name}`;
  }
}

/**
 * Read file contents (with truncation for large files)
 */
function readFile(p: string, workDir: string): string {
  const fullPath = path.resolve(workDir, p);
  if (!fullPath.startsWith(workDir)) {
    return 'Error: Path escapes workspace';
  }
  if (!fs.existsSync(fullPath)) {
    return 'Error: File not found';
  }
  try {
    const content = fs.readFileSync(fullPath, 'utf-8');
    // Truncate large files
    if (content.length > 10000) {
      return `${content.slice(0, 10000)}\n... (truncated)`;
    }
    return content;
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}

/**
 * List directory contents
 */
function ls(p: string | undefined, workDir: string): string {
  const dir = p ? path.resolve(workDir, p) : workDir;
  if (!dir.startsWith(workDir)) {
    return 'Error: Path escapes workspace';
  }
  if (!fs.existsSync(dir)) {
    return 'Error: Directory not found';
  }
  try {
    const items = fs.readdirSync(dir);
    return items.join('\n');
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}

/**
 * Search for pattern in files using grep
 */
function grep(pattern: string, p: string | undefined, workDir: string): string {
  const dir = p ? path.resolve(workDir, p) : workDir;
  if (!dir.startsWith(workDir)) {
    return 'Error: Path escapes workspace';
  }
  if (!fs.existsSync(dir)) {
    return 'Error: Directory not found';
  }
  try {
    // Use grep with line limit
    const result = execSync(
      `grep -rn "${pattern.replace(/"/g, '\\"')}" "${dir}" ` +
        `--include="*.ts" --include="*.js" --include="*.md" --include="*.json" ` +
        `2>/dev/null | head -50`,
      { encoding: 'utf-8', timeout: 10000, maxBuffer: 50 * 1024 }
    );
    return result || 'No matches found';
  } catch {
    return 'No matches found';
  }
}

/**
 * Mark a file as relevant to the topic
 */
function markFile(
  p: string,
  reason: string | undefined,
  workDir: string,
  markedFiles: Set<string>
): string {
  const fullPath = path.resolve(workDir, p);
  if (!fullPath.startsWith(workDir)) {
    return 'Error: Path escapes workspace';
  }
  if (!fs.existsSync(fullPath)) {
    return 'Error: File not found';
  }

  // Add to marked files
  markedFiles.add(p);

  return `Marked: ${p}${reason ? ` (${reason})` : ''}`;
}

/**
 * Mark a URL as relevant to the topic
 */
function markUrl(
  url: string,
  reason: string | undefined,
  markedUrls: Set<string>
): string {
  if (!url) {
    return 'Error: url is required';
  }

  // Validate URL format
  try {
    new URL(url);
  } catch {
    return 'Error: Invalid URL format';
  }

  // Add to marked URLs
  markedUrls.add(url);

  return `Marked URL: ${url}${reason ? ` (${reason})` : ''}`;
}

/**
 * Helper: Wrap a promise with a timeout
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(errorMessage));
    }, timeoutMs);
    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

/**
 * Search the web for information (with timeout)
 */
async function webSearch(query: string): Promise<string> {
  if (!query) {
    return 'Error: query is required';
  }

  try {
    const response = await withTimeout(
      ollama.webSearch({ query }),
      WEB_TIMEOUT_MS,
      `Web search timed out after ${WEB_TIMEOUT_MS / 1000}s`
    );
    const results = response.results || [];

    if (results.length === 0) {
      return 'No search results found.';
    }

    const lines = [`Found ${results.length} results for "${query}":\n`];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      lines.push(`## Result ${i + 1}`);
      lines.push(result.content || '(no content)');
      lines.push('');
    }

    return lines.join('\n');
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}

/**
 * Fetch content from a URL (with timeout)
 */
async function webFetch(url: string): Promise<string> {
  if (!url) {
    return 'Error: url is required';
  }

  // Validate URL format
  try {
    new URL(url);
  } catch {
    return 'Error: Invalid URL format. Please provide a valid URL starting with http:// or https://';
  }

  try {
    const response: WebFetchResponse = await withTimeout(
      ollama.webFetch({ url }),
      WEB_TIMEOUT_MS,
      `Web fetch timed out after ${WEB_TIMEOUT_MS / 1000}s`
    );

    const lines = [
      `## Fetched: ${response.title || 'Untitled'}`,
      `**URL:** ${url}\n`,
      '### Content',
      response.content || '(no content)',
      '',
    ];

    if (response.links && response.links.length > 0) {
      lines.push('### Links Found');
      for (const link of response.links.slice(0, 10)) {
        lines.push(`- ${link}`);
      }
      if (response.links.length > 10) {
        lines.push(`... and ${response.links.length - 10} more links`);
      }
    }

    return lines.join('\n');
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}

/**
 * Build the exploration prompt
 */
function buildExplorationPrompt(nodeTitle: string, nodeText: string, ancestorContext: string): string {
  return `You are exploring a codebase to write a summary for a documentation section.

## Section to Summarize
Title: ${nodeTitle}
Content:
${nodeText}

## Context from Parent Sections
${ancestorContext || '(root level - no parent context)'}

## Your Task
1. Use tools (read_file, ls, grep, mark_file, web_search, web_fetch, mark_url) to explore code and web resources relevant to this section
2. Use mark_file to mark local files that are directly relevant to this topic
3. Use mark_url to mark web URLs that contain important information
4. Discover implementation details, file locations, and code patterns
5. Write a concise summary (50-100 words) that includes:
   - What this section covers
   - Relevant files/modules (use mark_file)
   - Relevant URLs (use mark_url)
   - Key technical details

Explore now. When done exploring, write your summary.`;
}

/**
 * Core exploration agent loop - shared implementation
 * Returns summary enriched with discovered code context
 *
 * @param nodeTitle - The title of the section being summarized
 * @param nodeText - The text content of the section
 * @param ancestorContext - Combined text from parent sections
 * @param workDir - The working directory for file operations
 * @param maxRounds - Maximum number of LLM rounds
 * @param onProgress - Optional progress callback (round, tool name)
 * @returns Exploration result with summary and marked files
 */
async function runExplorationLoop(
  nodeTitle: string,
  nodeText: string,
  ancestorContext: string,
  workDir: string,
  maxRounds: number,
  onProgress?: (round: number, tool: string) => void
): Promise<ExplorationResult> {
  const messages: Message[] = [];
  const markedFiles = new Set<string>();
  const markedUrls = new Set<string>();

  const prompt = buildExplorationPrompt(nodeTitle, nodeText, ancestorContext);
  messages.push({ role: 'user', content: prompt });

  let rounds = 0;
  while (rounds < maxRounds) {
    rounds++;

    const response = await ollama.chat({
      model: MODEL,
      messages,
      tools: EXPLORER_TOOLS,
    });

    const assistantMsg = response.message;
    messages.push({
      role: 'assistant',
      content: assistantMsg.content || '',
      tool_calls: assistantMsg.tool_calls,
    });

    // Check for compaction after adding assistant message
    if (estimateTokens(messages) > TOKEN_THRESHOLD) {
      const compacted = await compactMessages(messages, nodeTitle);
      messages.length = 0;
      messages.push(...compacted);
    }

    // No tool calls = done
    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      return {
        summary: assistantMsg.content || '(no summary)',
        markedFiles: Array.from(markedFiles),
        markedUrls: Array.from(markedUrls),
      };
    }

    // Execute tool calls
    for (const tc of assistantMsg.tool_calls as ToolCall[]) {
      const toolName = tc.function.name;
      if (onProgress) {
        onProgress(rounds, toolName);
      }
      const output = await executeTool(
        toolName,
        tc.function.arguments as Record<string, unknown>,
        workDir,
        markedFiles,
        markedUrls
      );
      messages.push({
        role: 'tool',
        content: output,
        tool_call_id: tc.id,
      });
    }

    // Check for compaction after adding tool results
    if (estimateTokens(messages) > TOKEN_THRESHOLD) {
      const compacted = await compactMessages(messages, nodeTitle);
      messages.length = 0;
      messages.push(...compacted);
    }
  }

  // Max rounds reached - return last assistant message
  const lastAssistant = messages.filter((m) => m.role === 'assistant').pop();
  return {
    summary: lastAssistant?.content || '(exploration timeout)',
    markedFiles: Array.from(markedFiles),
    markedUrls: Array.from(markedUrls),
  };
}

/**
 * Run exploration agent loop (without progress reporting)
 * Returns summary enriched with discovered code context
 *
 * @param nodeTitle - The title of the section being summarized
 * @param nodeText - The text content of the section
 * @param ancestorContext - Combined text from parent sections
 * @param workDir - The working directory for file operations
 * @param maxRounds - Maximum number of LLM rounds (default: 10)
 * @returns Exploration result with summary and marked files
 */
export async function exploreAndSummarize(
  nodeTitle: string,
  nodeText: string,
  ancestorContext: string,
  workDir: string,
  maxRounds: number = MAX_ROUNDS_DEFAULT
): Promise<ExplorationResult> {
  return runExplorationLoop(nodeTitle, nodeText, ancestorContext, workDir, maxRounds);
}

/**
 * Summarize a node with exploration (used during compilation)
 * Wraps exploration loop with progress reporting
 */
export async function summarizeWithExplorer(
  nodeTitle: string,
  nodeText: string,
  ancestorContext: string,
  workDir: string,
  onProgress?: (round: number, tool: string) => void
): Promise<ExplorationResult> {
  return runExplorationLoop(nodeTitle, nodeText, ancestorContext, workDir, MAX_ROUNDS_DEFAULT, onProgress);
}