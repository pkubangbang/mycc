/**
 * get-node.ts - Tool for agent to query mindmap nodes
 *
 * Scope: ['main', 'child'] - Available to lead and teammates
 *
 * Parameters:
 * - path: Node path (e.g., "/skill/example")
 *
 * Returns node information including title, summary, text, and children.
 */

import type { ToolDefinition, AgentContext } from '../types.js';
import type { Node } from '../mindmap/types.js';

export const getNodeTool: ToolDefinition = {
  name: 'get_node',
  description: 'Get node information from mindmap by path. Use this to explore the knowledge tree structure.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Node path (e.g., "/skill/example" or "/" for root)',
      },
    },
    required: ['path'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const nodePath = args.path as string;

    // Ensure mindmap is loaded
    await ctx.mindmap.load();

    const node = ctx.mindmap.getNode(nodePath);
    if (!node) {
      return `Node not found: ${nodePath}\n\nAvailable paths start from root "/". Use get_node with path "/" to see top-level nodes.`;
    }

    return formatNode(node);
  },
};

/**
 * Format node for LLM consumption
 */
function formatNode(node: Node): string {
  const lines: string[] = [];
  
  lines.push(`# ${node.title}`);
  lines.push(`Path: ${node.id}`);
  lines.push(`Level: ${node.level}`);
  lines.push('');
  
  // Summary
  lines.push('## Summary');
  lines.push(node.summary || '(no summary)');
  lines.push('');
  
  // Text content (truncated if too long)
  if (node.text) {
    lines.push('## Content');
    const maxText = 2000;
    if (node.text.length > maxText) {
      lines.push(node.text.slice(0, maxText));
      lines.push(`\n... (${node.text.length - maxText} more characters)`);
    } else {
      lines.push(node.text);
    }
    lines.push('');
  }
  
  // Children
  if (node.children.length > 0) {
    lines.push('## Children');
    for (const child of node.children) {
      lines.push(`- ${child.title} (${child.id})`);
    }
    lines.push('');
  }
  
  // Links (if any)
  if (node.links.length > 0) {
    lines.push('## Links');
    for (const link of node.links) {
      const target = link.node_id || link.file_path || link.url;
      lines.push(`- ${link.target_type}: ${target}`);
      if (link.comment) {
        lines.push(`  ${link.comment}`);
      }
    }
    lines.push('');
  }
  
  return lines.join('\n');
}
