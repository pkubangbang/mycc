/**
 * web_fetch.ts - Fetch and parse content from a URL
 *
 * Scope: ['main', 'child'] - Available to lead and teammate agents
 */

import type { ToolDefinition, AgentContext } from '../types.js';
import { validateWebFetchUrl } from '../utils/web-url.js';
import { isCancellation } from '../loop/cancellation.js';

export const webFetchTool: ToolDefinition = {
  name: 'web_fetch',
  description:
    'Fetch and parse content from a URL. Returns page title, main content, and links. Use to read full content from URLs found via web_search.',
  input_schema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch content from'
      }
    },
    required: ['url']
  },
  scope: ['main', 'child'],

  handler: async (ctx: AgentContext, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> => {
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
    // target URL is handed to the configured Ollama server's web-fetch
    // endpoint, so the request originates from that server or its configured
    // backend, not directly from the mycc process. Operators routing through
    // a local/self-hosted backend must apply their own SSRF policy there.
    const validationError = validateWebFetchUrl(url);
    if (validationError) return validationError;

    ctx.core.brief('info', 'web_fetch', `Fetching: ${url}`);

    try {
      const response = await ctx.core.webFetch(url, signal);

      const linkCount = response.links?.length || 0;
      ctx.core.brief('info', 'web_fetch', `Fetched "${response.title}" (${linkCount} links)`);

      const lines = [
        `## Fetched: ${response.title}`,
        `**URL:** ${response.url}\n`,
        '### Content',
        response.content,
        ''
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
      // Cancellation is not a failure: rethrow so the single owner (Loader
      // then TOOL) can route it to STOP/wrap-up. Swallowing it here turned an
      // ESC or a teammate shutdown into `Error: The operation was aborted`,
      // which the model would reasonably retry.
      if (isCancellation(error, signal)) throw error;
      const err = error as Error;
      ctx.core.brief('error', 'web_fetch', `Failed: ${err.message}`);
      return `Error: ${err.message}`;
    }
  }
};
