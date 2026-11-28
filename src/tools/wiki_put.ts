/**
 * wiki_put.ts - Tool to store a document in the knowledge base
 */

import type { ToolDefinition, WikiDocument } from '../types.js';
import { WIKI_CONTENT_TOKEN_LIMITS } from '../context/parent/wiki.js';

export const wikiPutTool: ToolDefinition = {
  name: 'wiki_put',
  description:
    'Store a validated document in the knowledge base. Requires the hash from wiki_prepare, and the document passed must be the exact same one that was validated. ' +
    'To SUPERSEDE what you are replacing instead of leaving both behind, pass `supersedes` with the old document hashes: each one is tombstoned (logically deleted) in the same call, so the knowledge base keeps exactly one current lesson per trigger. ' +
    'Find the old hashes first with wiki_get — a title of the form "<file>: <trigger>" identifies a trace row, and that row\'s `hash` is what goes into `supersedes`.',
  input_schema: {
    type: 'object',
    properties: {
      hash: {
        type: 'string',
        description: 'The hash returned by wiki_prepare - must match the document content'
      },
      document: {
        type: 'object',
        properties: {
          domain: { type: 'string' },
          title: { type: 'string' },
          content: { type: 'string' },
          references: { type: 'array', items: { type: 'string' } }
        },
        required: ['domain', 'title', 'content']
      },
      supersedes: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional. Hashes of documents this one REPLACES. Each is tombstoned (logically deleted, still replayable from the write-ahead log) in the same call, so a trigger keeps exactly one current lesson. Obtain the hashes from wiki_get; ignore hashes that no longer exist.'
      }
    },
    required: ['hash', 'document']
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
      return `Error: document.content is required and must be a non-empty string. Content must be ${WIKI_CONTENT_TOKEN_LIMITS.min}-${WIKI_CONTENT_TOKEN_LIMITS.max} tokens.`;
    }

    const document: WikiDocument = {
      domain: docObj.domain,
      title: docObj.title,
      content: docObj.content,
      references: (docObj.references as string[]) || []
    };

    const result = await ctx.wiki.put(hash, document);

    // Tombstone every superseded document AFTER the new one lands, so a failed
    // put can never delete the only copy of the lesson. `delete` is a logical
    // delete (WAL tombstone, state=2): the row stays replayable, it just stops
    // being retrievable. Every hash is accounted for in the result — tombstoned,
    // already absent, or invalid — so a mistyped hash is never a silent no-op.
    const supersededRaw = args.supersedes;
    const tombstoned: string[] = [];
    const missing: string[] = [];
    const invalid: string[] = [];
    const failed: string[] = [];
    if (Array.isArray(supersededRaw)) {
      // Dedupe first: a hash listed twice would otherwise be tombstoned on the
      // first pass and reported "absent" on the second, telling the model its
      // own successful supersede only half worked.
      for (const entry of new Set(supersededRaw)) {
        if (typeof entry !== 'string' || !/^[a-f0-9]{16}$/.test(entry)) {
          invalid.push(String(entry));
          continue;
        }
        if (!result.success || entry === result.hash) continue; // nothing written / never tombstone what we just wrote
        try {
          if (await ctx.wiki.delete(entry)) {
            tombstoned.push(entry);
          } else {
            missing.push(entry);
          }
        } catch (err) {
          // The document is already stored; a tombstone failure must not turn a
          // successful put into an Error result. Report it and let the model retry.
          failed.push(`${entry} (${err instanceof Error ? err.message : String(err)})`);
        }
      }
      if (tombstoned.length > 0) {
        ctx.core.brief('info', 'wiki_put', `Superseded ${tombstoned.length} document(s): ${tombstoned.join(', ')}`);
      }
    }

    if (result.success) {
      const parts: string[] = [];
      if (tombstoned.length > 0) parts.push(`superseded ${tombstoned.join(', ')}`);
      if (missing.length > 0) parts.push(`already absent ${missing.join(', ')}`);
      if (invalid.length > 0) parts.push(`INVALID (not tombstoned) ${invalid.join(', ')}`);
      if (failed.length > 0) parts.push(`FAILED to tombstone ${failed.join(', ')}`);
      const supersededNote = parts.length > 0 ? `; ${parts.join('; ')}` : '';
      if (result.alreadyExisted) {
        // Document already exists (exact match — same hash AND references)
        ctx.core.brief(
          'info',
          'wiki_put',
          `Document "${document.title}" (${document.domain}) already exists (hash: ${result.hash})`
        );
        return `OK: Document already exists with hash ${result.hash}${supersededNote}`;
      }
      ctx.core.brief(
        'info',
        'wiki_put',
        `Stored document "${document.title}" (${document.domain}) with hash ${result.hash}`
      );
      return `OK: Document stored successfully with hash ${result.hash}${supersededNote}`;
    } else {
      ctx.core.brief('warn', 'wiki_put', `Failed to store document "${document.title}": ${result.error}`);
      return `Error: ${result.error}`;
    }
  }
};
