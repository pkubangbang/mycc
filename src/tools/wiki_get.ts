/**
 * wiki_get.ts - Tool to retrieve documents from the knowledge base
 */

import type { ToolDefinition, GetOptions } from '../types.js';

export const wikiGetTool: ToolDefinition = {
  name: 'wiki_get',
  description: 'Search knowledge base for relevant documents. Domain parameter is required. Returns documents sorted by similarity to query.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query - describe what knowledge you are looking for',
      },
      domain: {
        type: 'string',
        description: 'Required: the domain to search within (e.g., "project", "architecture")',
      },
      topK: {
        type: 'number',
        description: 'Number of results to return (default: 5)',
      },
      threshold: {
        type: 'number',
        description: 'Minimum similarity threshold (0-1, default: 0)',
      },
    },
    required: ['query', 'domain'],
  },
  scope: ['main', 'child'],
  handler: async (ctx, args): Promise<string> => {
    const query = args.query as string;
    const options: GetOptions = {};

    if (args.domain) options.domain = args.domain as string;
    if (args.topK !== undefined) options.topK = args.topK as number;
    if (args.threshold !== undefined) options.threshold = args.threshold as number;

    const results = await ctx.wiki.get(query, options);

    if (results.length === 0) {
      return 'No documents found matching your query.';
    }

    const lines: string[] = [];
    lines.push(`Found ${results.length} document(s):\n`);

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      lines.push(`[${i + 1}] ${result.document.title}`);
      lines.push(`    Domain: ${result.document.domain}`);
      lines.push(`    Similarity: ${(result.similarity * 100).toFixed(1)}%`);
      lines.push(`    Hash: ${result.hash}`);
      lines.push(`    Content: ${result.document.content.slice(0, 200)}${result.document.content.length > 200 ? '...' : ''}`);
      if (result.document.references.length > 0) {
        lines.push(`    References: ${result.document.references.join(', ')}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  },
};