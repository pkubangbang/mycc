/**
 * wiki_put.ts - Tool to store a document in the knowledge base
 */

import type { ToolDefinition, WikiDocument } from '../types.js';

export const wikiPutTool: ToolDefinition = {
  name: 'wiki_put',
  description: 'Store a validated document in knowledge base. Requires hash from wiki_prepare. Pass the exact same document that was validated. Example: wiki_put(hash="abc", document={domain:"pitfall", title:"my title", content:"my content", references:["ref1"]})',
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

    // Validate hash format before proceeding
    if (!hash || hash.trim() === '') {
      return 'Error: Hash is required. Use wiki_prepare first to validate the document and get a hash.';
    }

    // Hash should be 16-character hex string (from SHA256 truncated)
    if (!/^[a-f0-9]{16}$/.test(hash)) {
      return `Error: Invalid hash format "${hash}". Use wiki_prepare first to get a valid hash for this document.`;
    }

    // Validate document parameter — must be a JSON object, not a double-encoded string
    const doc = args.document;
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
      return `Error: document must be a JSON object (e.g., {domain: "pitfall", title: "...", content: "..."}), but got ${typeof doc}. Do NOT stringify the document field.`;
    }
    const docObj = doc as Record<string, unknown>;
    if (typeof docObj.domain !== 'string' || docObj.domain.trim() === '') {
      return 'Error: document.domain is required and must be a non-empty string.';
    }
    if (typeof docObj.title !== 'string' || docObj.title.trim() === '') {
      return 'Error: document.title is required and must be a non-empty string.';
    }
    if (typeof docObj.content !== 'string' || docObj.content.trim() === '') {
      return 'Error: document.content is required and must be a non-empty string. Content must be 50-1000 characters.';
    }

    const document: WikiDocument = {
      domain: docObj.domain,
      title: docObj.title,
      content: docObj.content,
      references: (docObj.references as string[]) || [],
    };

    const result = await ctx.wiki.put(hash, document);

    if (result.success) {
      if (result.error) {
        // Document already existed
        ctx.core.brief('info', 'wiki_put', `Document "${document.title}" (${document.domain}) already exists (hash: ${result.hash})`);
        return `OK: Document already exists with hash ${result.hash}`;
      }
      ctx.core.brief('info', 'wiki_put', `Stored document "${document.title}" (${document.domain}) with hash ${result.hash}`);
      return `OK: Document stored successfully with hash ${result.hash}`;
    } else {
      ctx.core.brief('warn', 'wiki_put', `Failed to store document "${document.title}": ${result.error}`);
      return `Error: ${result.error}`;
    }
  },
};