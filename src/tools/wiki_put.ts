/**
 * wiki_put.ts - Tool to store a document in the knowledge base
 */

import type { ToolDefinition, WikiDocument } from '../types.js';

export const wikiPutTool: ToolDefinition = {
  name: 'wiki_put',
  description: `Store a document in the knowledge base. Use this after wiki_prepare returns an accepted hash.
Pass the exact same document and the hash returned by wiki_prepare. The domain will be automatically registered if it's new.`,
  input_schema: {
    type: 'object',
    properties: {
      hash: {
        type: 'string',
        description: 'The hash returned by wiki_prepare - must match the document content',
      },
      document: {
        type: 'object',
        properties: {
          domain: { type: 'string' },
          title: { type: 'string' },
          content: { type: 'string' },
          references: { type: 'array', items: { type: 'string' } },
        },
        required: ['domain', 'title', 'content'],
      },
    },
    required: ['hash', 'document'],
  },
  scope: ['main', 'child'],
  handler: async (ctx, args): Promise<string> => {
    const hash = args.hash as string;
    const doc = args.document as Record<string, unknown>;

    // Validate hash format before proceeding
    if (!hash || hash.trim() === '') {
      return 'Error: Hash is required. Use wiki_prepare first to validate the document and get a hash.';
    }

    // Hash should be 16-character hex string (from SHA256 truncated)
    if (!/^[a-f0-9]{16}$/.test(hash)) {
      return `Error: Invalid hash format "${hash}". Use wiki_prepare first to get a valid hash for this document.`;
    }

    const document: WikiDocument = {
      domain: doc.domain as string,
      title: doc.title as string,
      content: doc.content as string,
      references: (doc.references as string[]) || [],
    };

    const result = await ctx.wiki.put(hash, document);

    if (result.success) {
      if (result.error) {
        // Document already existed
        return `OK: Document already exists with hash ${result.hash}`;
      }
      return `OK: Document stored successfully with hash ${result.hash}`;
    } else {
      return `Error: ${result.error}`;
    }
  },
};