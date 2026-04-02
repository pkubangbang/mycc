/**
 * web_fetch.ts - Fetch and parse content from a URL
 *
 * Scope: ['main', 'child'] - Available to lead and teammate agents
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const webFetchTool: ToolDefinition = {
  name: 'web_fetch',
  description:
    'Fetch and parse content from a specific URL. Returns the page title, main content, and links found on the page. Use this to read full content from a URL found via web_search.',
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

    // Validate URL format
    try {
      new URL(url);
    } catch {
      return 'Error: Invalid URL format. Please provide a valid URL starting with http:// or https://';
    }

    try {
      const response = await ctx.core.webFetch(url);

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
      return `Error: ${err.message}`;
    }
  },
};