/**
 * web_search.ts - Search the web using Ollama's web search API
 *
 * Scope: ['main', 'child'] - Available to lead and teammate agents
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const webSearchTool: ToolDefinition = {
  name: 'web_search',
  description: 'Search the web for information. Returns titles, URLs, and snippets. Use for current information, documentation, or research.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query to execute',
      },
    },
    required: ['query'],
  },
  scope: ['main', 'child'],

  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const query = args.query as string;
    if (!query) {
      return 'Error: query is required';
    }

    ctx.core.brief('info', 'web_search', `Searching: "${query}"`);

    try {
      const results = await ctx.core.webSearch(query);

      if (results.length === 0) {
        ctx.core.brief('info', 'web_search', 'No results found');
        return 'No search results found.';
      }

      ctx.core.brief('info', 'web_search', `Found ${results.length} result${results.length === 1 ? '' : 's'}`);

      const lines = [`Found ${results.length} results for "${query}":\n`];

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        lines.push(`## Result ${i + 1}`);
        lines.push(result.content);
        lines.push('');
      }

      return lines.join('\n');
    } catch (error: unknown) {
      const err = error as Error;
      ctx.core.brief('error', 'web_search', `Failed: ${err.message}`);
      return `Error: ${err.message}`;
    }
  },
};