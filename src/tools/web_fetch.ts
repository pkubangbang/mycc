/**
 * web_fetch.ts - Fetch and parse content from a URL
 *
 * Scope: ['main', 'child'] - Available to lead and teammate agents
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const webFetchTool: ToolDefinition = {
  name: 'web_fetch',
  description: 'Fetch and parse content from a URL. Returns page title, main content, and links. Use to read full content from URLs found via web_search.',
  input_schema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch content from',
      },
    },
    required: ['url'],
  },
  scope: ['main', 'child'],

  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const url = args.url as string;
    if (!url) {
      return 'Error: url is required';
    }

    // Validate URL format + protocol allowlist.
    // `new URL()` accepts any scheme (file:, ftp:, data:, javascript:, ...),
    // but the error message below has always promised "http:// or https://".
    // Enforce it here (the sole URL-validation chokepoint before the URL is
    // handed to the provider's fetch). Non-http(s) schemes are rejected
    // rather than forwarded — the downstream fetch is a web fetch, so a
    // file:/ftp:/data: URL has no useful behavior there anyway.
    // NOTE: private-IP / SSRF blocking is intentionally NOT added here. The
    // actual fetch is performed server-side by the provider (Ollama cloud's
    // ollama.webFetch, or 'not supported' under DeepSeek), so a request to a
    // private/metadata IP would originate from the provider's infra, not the
    // mycc process — classic SSRF against the user's own metadata endpoint
    // (e.g. 169.254.169.254) does not apply, and IP blocking would also break
    // legitimate local-Ollama setups.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return 'Error: Invalid URL format. Please provide a valid URL starting with http:// or https://';
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return `Error: Unsupported URL protocol "${parsed.protocol}". Only http:// and https:// are supported.`;
    }

    ctx.core.brief('info', 'web_fetch', `Fetching: ${url}`);

    try {
      const response = await ctx.core.webFetch(url);

      const linkCount = response.links?.length || 0;
      ctx.core.brief('info', 'web_fetch', `Fetched "${response.title}" (${linkCount} links)`);

      const lines = [
        `## Fetched: ${response.title}`,
        `**URL:** ${url}\n`,
        '### Content',
        response.content,
        '',
      ];

      if (response.links && response.links.length > 0) {
        lines.push('### Links Found');
        for (const link of response.links.slice(0, 20)) {
          // Limit to 20 links
          lines.push(`- ${link}`);
        }
        if (response.links.length > 20) {
          lines.push(`... and ${response.links.length - 20} more links`);
        }
      }

      return lines.join('\n');
    } catch (error: unknown) {
      const err = error as Error;
      ctx.core.brief('error', 'web_fetch', `Failed: ${err.message}`);
      return `Error: ${err.message}`;
    }
  },
};