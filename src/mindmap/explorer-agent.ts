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

import { MODEL, retryChat, webSearch as engineWebSearch, webFetch as engineWebFetch } from '../engine/chat-provider.js';
import type { Message, Tool, ToolCall } from '../types.js';
import type { WebFetchResponse } from 'ollama';
import * as fs from 'fs';
import * as path from 'path';
import { minifyMessages } from '../utils/llm-chat-minifier.js';
import { getTokenThreshold, getMyccDir, ensureDirs } from '../config.js';
import { agentIO } from '../loop/agent-io.js';
import { grepSearch } from '../utils/grep-search.js';

/**
 * Configuration constants
 */
const MAX_ROUNDS_DEFAULT = 50;
const WEB_TIMEOUT_MS = 30000; // 30 seconds timeout for web operations
const TOKEN_THRESHOLD = getTokenThreshold();

/**
 * Marked item with path/URL and reason
 */
export interface MarkedItem {
  path: string;
  reason?: string;
}

/**
 * Marked term from exploration
 */
export interface MarkedTerm {
  /** The term name (e.g. "STAR principle", "microCompact") */
  term: string;
  /** Brief context or definition for this term */
  context?: string;
}

/**
 * Result of exploration - summary and marked files/URLs
 */
export interface ExplorationResult {
  summary: string;
  markedFiles: MarkedItem[];
  markedUrls: MarkedItem[];
  markedTerms: MarkedTerm[];
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

  const response = await retryChat(
    {
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
      think: false,
    },
    { noSpinner: true },
  );

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
  {
    type: 'function',
    function: {
      name: 'mark_term',
      description:
        'Mark a project-specific term or concept as important and hoist it to be discoverable from root.\n' +
        'Use this when you find a technical term, jargon, or named concept that is defined or central to this section.\n' +
        'Terms are collected recursively and displayed at the mindmap root for quick discovery.\n' +
        'Examples: "STAR principle", "microCompact", "triologue", "neglected mode", "ANC-E", "agent loop"',
      parameters: {
        type: 'object',
        properties: {
          term: {
            type: 'string',
            description: 'The term name (e.g. "STAR principle", "microCompact", "triologue")',
          },
          context: {
            type: 'string',
            description: 'Brief definition or context for this term (one sentence)',
          },
        },
        required: ['term'],
      },
    },
  },
];

/**
 * Execute a tool call
 * @returns Tool output string
 * @param markedFiles - Set to track marked files (passed by reference)
 * @param markedUrls - Set to track marked URLs (passed by reference)
 * @param markedTerms - Set to track marked terms (passed by reference)
 */
async function executeTool(
  name: string,
  args: Record<string, unknown>,
  workDir: string,
  markedFiles: MarkedItem[],
  markedUrls: MarkedItem[],
  markedTerms: MarkedTerm[]
): Promise<string> {
  switch (name) {
    case 'read_file':
      return readFile(args.path as string, workDir);
    case 'ls':
      return ls(args.path as string | undefined, workDir);
    case 'grep':
      return await grep(
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
    case 'mark_term':
      return markTerm(
        args.term as string,
        args.context as string | undefined,
        markedTerms
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
 * Search for pattern in files using the shared grep tool.
 * Delegates to grepSearch() which has hierarchical fallback:
 * native rg → system grep → npm ripgrep WASM → error.
 */
async function grep(pattern: string, p: string | undefined, workDir: string): Promise<string> {
  const dir = p ? path.resolve(workDir, p) : workDir;
  if (!dir.startsWith(workDir)) {
    return 'Error: Path escapes workspace';
  }
  if (!fs.existsSync(dir)) {
    return 'Error: Directory not found';
  }
  const { output } = await grepSearch(pattern, dir, undefined, 50);
  return output;
}

/**
 * Mark a file as relevant to the topic
 */
function markFile(
  p: string,
  reason: string | undefined,
  workDir: string,
  markedFiles: MarkedItem[]
): string {
  const fullPath = path.resolve(workDir, p);
  if (!fullPath.startsWith(workDir)) {
    return 'Error: Path escapes workspace';
  }
  if (!fs.existsSync(fullPath)) {
    return 'Error: File not found';
  }

  // Check if already marked
  if (markedFiles.some((item) => item.path === p)) {
    return `Already marked: ${p}`;
  }

  // Add to marked files with reason
  markedFiles.push({ path: p, reason });

  return `Marked: ${p}${reason ? ` (${reason})` : ''}`;
}

/**
 * Mark a URL as relevant to the topic
 */
function markUrl(
  url: string,
  reason: string | undefined,
  markedUrls: MarkedItem[]
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

  // Check if already marked
  if (markedUrls.some((item) => item.path === url)) {
    return `Already marked: ${url}`;
  }

  // Add to marked URLs with reason
  markedUrls.push({ path: url, reason });

  return `Marked URL: ${url}${reason ? ` (${reason})` : ''}`;
}

/**
 * Mark a term as relevant to the topic
 * Terms are hoisted to root-level discoverability
 */
function markTerm(
  term: string,
  context: string | undefined,
  markedTerms: MarkedTerm[]
): string {
  if (!term) {
    return 'Error: term is required';
  }

  // Check if already marked (case-insensitive)
  if (markedTerms.some((item) => item.term.toLowerCase() === term.toLowerCase())) {
    return `Already marked: ${term}`;
  }

  // Add to marked terms
  markedTerms.push({ term, context });

  return `Marked term: ${term}${context ? ` (${context})` : ''}`;
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
    const results = await withTimeout(
      engineWebSearch(query),
      WEB_TIMEOUT_MS,
      `Web search timed out after ${WEB_TIMEOUT_MS / 1000}s`
    );

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
      engineWebFetch(url),
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
4. Use mark_term to mark project-specific terms or concepts that are defined or central to this section (these will be hoisted to the mindmap root for quick discovery)
5. Discover implementation details, file locations, and code patterns
6. Write a concise summary that includes:
   - What this section covers
   - Relevant files/modules (use mark_file)
   - Relevant URLs (use mark_url)
   - Key terms (use mark_term)
   - Key technical details

Explore now. When done exploring, write your summary. Produce only the summary, without any additional explanations or commentary.`;
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
 * @param onProgress - Optional progress callback (round, tool name, tool args)
 * @returns Exploration result with summary and marked files
 */
async function runExplorationLoop(
  nodeTitle: string,
  nodeText: string,
  ancestorContext: string,
  workDir: string,
  maxRounds: number,
  onProgress?: (round: number, tool: string, args: Record<string, unknown>) => void
): Promise<ExplorationResult> {
  const messages: Message[] = [];
  const markedFiles: MarkedItem[] = [];
  const markedUrls: MarkedItem[] = [];
  const markedTerms: MarkedTerm[] = [];

  const prompt = buildExplorationPrompt(nodeTitle, nodeText, ancestorContext);
  messages.push({ role: 'user', content: prompt });

  let rounds = 0;
  while (rounds < maxRounds) {
    rounds++;

    let response;
    try {
      response = await retryChat(
        {
          model: MODEL,
          messages,
          tools: EXPLORER_TOOLS,
          think: false,
        },
        { noSpinner: true },
      );
    } catch (err) {
      agentIO.brief('warn', 'explorer', `LLM chat failed at round ${rounds} for "${nodeTitle}": ${(err as Error).message}`);
      // Non-transient error or all retries exhausted - stop the loop with what we have
      break;
    }

    const assistantMsg = response.message;
    messages.push({
      role: 'assistant',
      content: assistantMsg.content || '',
      tool_calls: assistantMsg.tool_calls,
    });

    // Check for compaction after adding assistant message
    if (estimateTokens(messages) > TOKEN_THRESHOLD) {
      try {
        const compacted = await compactMessages(messages, nodeTitle);
        messages.length = 0;
        messages.push(...compacted);
      } catch (err) {
        agentIO.brief('warn', 'explorer', `Compaction failed for "${nodeTitle}": ${(err as Error).message}. Continuing with full context.`);
        // Continue with uncompacted messages - better than crashing
      }
    }

    // No tool calls = done
    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      return {
        summary: assistantMsg.content || '(no summary)',
        markedFiles,
        markedUrls,
        markedTerms,
      };
    }

    // Execute tool calls (each individually guarded)
    for (const tc of assistantMsg.tool_calls as ToolCall[]) {
      const toolName = tc.function.name;
      if (onProgress) {
        onProgress(rounds, toolName, tc.function.arguments as Record<string, unknown>);
      }
      let output: string;
      try {
        output = await executeTool(
          toolName,
          tc.function.arguments as Record<string, unknown>,
          workDir,
          markedFiles,
          markedUrls,
          markedTerms
        );
      } catch (err) {
        output = `Tool execution error [${toolName}]: ${(err as Error).message}`;
        agentIO.brief('warn', 'explorer', `Tool ${toolName} failed for "${nodeTitle}": ${(err as Error).message}`);
      }
      messages.push({
        role: 'tool',
        content: output,
        tool_call_id: tc.id,
      });
    }

    // Check for compaction after adding tool results
    if (estimateTokens(messages) > TOKEN_THRESHOLD) {
      try {
        const compacted = await compactMessages(messages, nodeTitle);
        messages.length = 0;
        messages.push(...compacted);
      } catch (err) {
        agentIO.brief('warn', 'explorer', `Compaction failed for "${nodeTitle}": ${(err as Error).message}. Continuing with full context.`);
      }
    }
  }

  // Max rounds reached or error broke out - return last assistant message
  const lastAssistant = messages.filter((m) => m.role === 'assistant').pop();
  return {
    summary: lastAssistant?.content || '(exploration timeout)',
    markedFiles,
    markedUrls,
    markedTerms,
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
  onProgress?: (round: number, tool: string, args: Record<string, unknown>) => void
): Promise<ExplorationResult> {
  return runExplorationLoop(nodeTitle, nodeText, ancestorContext, workDir, MAX_ROUNDS_DEFAULT, onProgress);
}