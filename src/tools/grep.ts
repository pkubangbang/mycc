/**
 * grep.ts - grep tool for LLM agents
 *
 * Scope: ['main', 'child'] - Available to lead and teammate agents
 *
 * Delegates the actual search to src/utils/grep-search.ts which has
 * a hierarchical fallback: native rg → system grep/PowerShell → WASM ripgrep.
 */

import type { ToolDefinition, AgentContext } from '../types.js';
import * as path from 'path';
import { retryChat, MODEL } from '../engine/chat-provider.js';
import { grepSearch, DEFAULT_MAX_RESULTS, MAX_MAX_RESULTS } from '../utils/grep-search.js';

export { grepSearch } from '../utils/grep-search.js';

const OUTPUT_CHAR_LIMIT = 20000;
const IS_WINDOWS = process.platform === 'win32';

/**
 * Build platform-appropriate fallback error message.
 */
function buildFallbackError(): string {
  if (IS_WINDOWS) {
    return (
      'Error: No search tool available.\n' +
      'Use the bash tool instead, but be careful:\n' +
      '1. Use PowerShell: Get-ChildItem -Recurse -File | Select-String -Pattern "pattern"\n' +
      '2. Limit results: Get-ChildItem -Recurse -File | Select-String "pattern" | Select-Object -First 100\n' +
      '3. Exclude node_modules: Get-ChildItem -Recurse -File | Where-Object { $_ -notmatch "node_modules" } | Select-String "pattern"\n' +
      '4. Reuse bash output: pipe earlier results to Select-String for further filtering'
    );
  }
  return (
    'Error: No search tool available (rg, grep, or ripgrep WASM).\n' +
    'Use the bash tool instead, but be careful:\n' +
    '1. Exclude node_modules: grep -rn --exclude-dir=node_modules pattern .\n' +
    '2. Exclude dependency folders: --exclude-dir=node_modules --exclude-dir=.git\n' +
    '3. Limit results: | head -n 100'
  );
}

export const grepTool: ToolDefinition = {
  name: 'grep',
  description:
    'Search for a pattern in files. Use this instead of "bash grep" — it automatically excludes node_modules and respects .gitignore when using ripgrep.',
  input_schema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'The search pattern (regex compatible)',
      },
      path: {
        type: 'string',
        description: 'Directory to search (default: workspace root)',
      },
      include: {
        type: 'string',
        description: 'File glob pattern to include, e.g., "*.ts" or "*.md"',
      },
      maxResults: {
        type: 'number',
        description: `Maximum results to return (default: ${DEFAULT_MAX_RESULTS}, max: ${MAX_MAX_RESULTS})`,
      },
    },
    required: ['pattern'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const pattern = args.pattern as string;
    const searchPath = (args.path as string) || '.';
    const include = args.include as string | undefined;
    const maxResults = (args.maxResults as number) || DEFAULT_MAX_RESULTS;

    const workDir = ctx.core.getWorkDir();
    const resolvedDir = path.resolve(workDir, searchPath);

    if (!resolvedDir.startsWith(workDir)) {
      const msg = `Error: search path "${searchPath}" escapes workspace`;
      ctx.core.brief('error', 'grep', msg);
      return msg;
    }

    const { output, method } = await grepSearch(pattern, resolvedDir, include, maxResults);

    if (method === 'none') {
      ctx.core.brief('error', 'grep', 'No search tool available', buildFallbackError());
      return buildFallbackError();
    }

    ctx.core.verbose('grep', `Searched with ${method}`, { pattern, searchPath, resultsLen: output.length });

    if (output.length <= OUTPUT_CHAR_LIMIT) {
      return output || 'No matches found';
    }

    try {
      const summary = await summarizeGrepOutput(output, pattern, output.length, ctx);
      return summary;
    } catch (err) {
      ctx.core.brief('error', 'grep', `Failed to summarize output: ${(err as Error).message}`);
      return `[Summarization failed, showing raw output]\n\n${output}`;
    }
  },
};

async function summarizeGrepOutput(
  output: string,
  pattern: string,
  totalChars: number,
  ctx: AgentContext
): Promise<string> {
  ctx.core.brief('info', 'grep', `Summarizing ${(totalChars / 1000).toFixed(1)}k chars (limit: ${OUTPUT_CHAR_LIMIT / 1000}k)`);

  const response = await retryChat({
    model: MODEL,
    messages: [
      {
        role: 'system',
        content: `Summarize this grep output concisely.
Search pattern: ${pattern}
Total characters: ${totalChars}
Group results by file. Highlight the most relevant matches.
Keep the summary concise and focused on what's relevant to the search pattern.`,
      },
      { role: 'user', content: output },
    ],
  });

  return `Summary of ${(totalChars / 1000).toFixed(1)}k chars (pattern: ${pattern}):\n${response.message.content || 'No summary generated'}`;
}
