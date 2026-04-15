/**
 * wiki_prepare.ts - Tool to evaluate a document for storage in the knowledge base
 */

import type { ToolDefinition, WikiDocument } from '../types.js';

export const wikiPrepareTool: ToolDefinition = {
  name: 'wiki_prepare',
  description: `Check if a document is suitable for the knowledge base. Returns a hash if accepted, or a rejection reason if not.
Use this before wiki_put. The document should contain facts or rules, not opinions. Content must be 50-1000 characters.`,
  input_schema: {
    type: 'object',
    properties: {
      domain: {
        type: 'string',
        description: 'Category tag for the knowledge (e.g., "project", "architecture", "api")',
      },
      title: {
        type: 'string',
        description: 'Document title - a brief summary of the knowledge',
      },
      content: {
        type: 'string',
        description: 'Document content - facts, rules, or information to store. Must be 50-1000 characters. Should describe facts/rules, not opinions.',
      },
      references: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of reference URLs or file paths for this knowledge',
      },
    },
    required: ['domain', 'title', 'content'],
  },
  scope: ['main', 'child'],
  handler: async (ctx, args): Promise<string> => {
    const document: WikiDocument = {
      domain: args.domain as string,
      title: args.title as string,
      content: args.content as string,
      references: (args.references as string[]) || [],
    };

    const result = await ctx.wiki.prepare(document);
    return JSON.stringify(result, null, 2);
  },
};