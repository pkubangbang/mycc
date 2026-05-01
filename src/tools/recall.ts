/**
 * recall.ts - Tool for agent to query mindmap nodes
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
import { get_node, load_mindmap, get_default_mindmap_path } from '../mindmap/index.js';
import * as fs from 'fs';

export const recallTool: ToolDefinition = {
  name: 'recall',
  description: `**KNOWLEDGE DISCOVERY TOOL** - Explore the mindmap knowledge tree to understand project structure, available skills, and context. 

⭐ START with \`recall(path="/")\` to see all top-level knowledge categories, then navigate deeper into interesting paths.

This tool helps you understand:
- Project architecture and design decisions
- Available skills and their purposes  
- Domain knowledge and best practices
- Code patterns and conventions

PREFER this over reading files when you need high-level understanding. Use read/bash for specific implementation details.`,
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Node path (e.g., "/skill/example" or "/" for root). Start with "/" to discover available knowledge.',
      },
    },
    required: ['path'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const nodePath = args.path as string;

    // Get mindmap from core, load if not already loaded
    let mindmap = ctx.core.getMindmap();
    if (!mindmap) {
      const workDir = ctx.core.getWorkDir();
      const mindmapPath = get_default_mindmap_path(workDir);
      if (!fs.existsSync(mindmapPath)) {
        return 'No mindmap found. Use /mindmap compile <file> to create one.';
      }
      mindmap = load_mindmap(mindmapPath);
      ctx.core.setMindmap(mindmap);
    }

    const node = get_node(mindmap, nodePath);
    if (!node) {
      return `Node not found: ${nodePath}\n\nAvailable paths start from root "/". Use recall with path "/" to see top-level nodes.`;
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