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
  description: `Explore the mindmap knowledge tree for project structure, available skills, and context. Start with recall(path="/") to see top-level categories, then drill down into children.`,
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

    ctx.core.brief('info', 'recall', `Exploring: ${nodePath}`);

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

    // Collect hoisted terms only when querying root
    const hoistedTerms = nodePath === '/' ? collectDescendantTerms(mindmap.root) : [];

    return formatNode(node, hoistedTerms);
  },
};

/**
 * Collect all marked terms from all descendant nodes, deduplicated
 * Returns deduplicated list sorted alphabetically by term name
 */
function collectDescendantTerms(node: Node): Array<{ term: string; path: string; context: string }> {
  const terms = new Map<string, { term: string; path: string; context: string }>();

  function walk(n: Node) {
    for (const link of n.links) {
      if (link.target_type === 'term' && link.term_name) {
        const key = link.term_name.toLowerCase();
        if (!terms.has(key)) {
          // Deduplicate: first occurrence wins (the node that defines the term)
          terms.set(key, {
            term: link.term_name,
            path: n.id,
            context: link.comment,
          });
        }
      }
    }
    for (const child of n.children) {
      walk(child);
    }
  }

  walk(node);

  // Sort alphabetically for consistent output
  return Array.from(terms.values()).sort((a, b) => a.term.localeCompare(b.term));
}

/**
 * Format node for LLM consumption
 */
function formatNode(
  node: Node,
  hoistedTerms?: Array<{ term: string; path: string; context: string }>
): string {
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
    lines.push('_Drill down by using recall with any child path (slash-separated)._');
    lines.push('');
    for (const child of node.children) {
      lines.push(`- ${child.title} → recall(path="${child.id}")`);
    }
    lines.push('');
  }

  // Hoisted terms (only shown for root node)
  if (hoistedTerms && hoistedTerms.length > 0) {
    lines.push('## Key Terms');
    lines.push('_Project-specific terminology defined in this codebase. Use recall to drill down._');
    lines.push('');
    for (const term of hoistedTerms) {
      lines.push(`- ${term.term} → recall(path="${term.path}")`);
      if (term.context) {
        lines.push(`  ${term.context}`);
      }
    }
    lines.push('');
  }

  // Links (if any)
  if (node.links.length > 0) {
    lines.push('## Links');
    for (const link of node.links) {
      const target = link.node_id || link.file_path || link.url || link.term_name;
      lines.push(`- ${link.target_type}: ${target}`);
      if (link.comment) {
        lines.push(`  ${link.comment}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}
