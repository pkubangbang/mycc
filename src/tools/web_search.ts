/**
 * web_search.ts - Search the web using Ollama's web search API
 *
 * Scope: ['main', 'child'] - Available to lead and teammate agents
 */

import type { ToolDefinition, AgentContext } from '../types.js';
import { isCancellation } from '../loop/cancellation.js';

export const webSearchTool: ToolDefinition = {
  name: 'web_search',
  description: 'Search the web for information. Returns titles, URLs, and snippets. Use for current information, documentation, or research.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query',
      },
    },
    required: ['query'],
  },
  scope: ['main', 'child'],

  handler: async (ctx: AgentContext, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> => {
    const query = args.query as string;
    if (!query) {
      return 'Error: query is required';
    }

    ctx.core.brief('info', 'web_search', `Searching: "${query}"`);

    try {
      const results = await ctx.core.webSearch(query, signal);

      if (results.length === 0) {
        ctx.core.brief('info', 'web_search', 'No results found');
        return 'No search results found.';
      }

      ctx.core.brief('info', 'web_search', `Found ${results.length} result${results.length === 1 ? '' : 's'}`);

      const lines = [`Found ${results.length} results for "${query}":\n`];

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        lines.push(`## Result ${i + 1}${result.title ? `: ${result.title}` : ''}`);
        if (result.url) lines.push(`**URL:** ${result.url}`);
        lines.push(result.content);
        lines.push('');
      }

      return lines.join('\n');
    } catch (error: unknown) {
      // Same rule as web_fetch: a cancelled search is rethrown, never reported
      // to the model as an error it should retry. See src/loop/cancellation.ts.
      if (isCancellation(error, signal)) throw error;
      const err = error as Error;
      ctx.core.brief('error', 'web_search', `Failed: ${err.message}`);
      return `Error: ${err.message}`;
    }
  },
};
