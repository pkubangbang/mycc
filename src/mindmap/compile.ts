/**
 * compile.ts - Compile markdown into mindmap
 * @see docs/mindmap-design.md
 * 
 * Compilation process:
 * 1. Parse markdown into sections by heading hierarchy
 * 2. Build tree structure from sections
 * 3. Generate summaries bottom-up using A-N-C-E context
 * 4. Compute hash and return mindmap
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { MindmapJSON, Node, MarkdownSection, Link } from './types.js';
import { compute_file_hash } from './validate.js';

/**
 * Regular expressions for markdown parsing
 */
const HEADING_REGEX = /^(#{1,6})\s+(.+)$/;
const LINK_REGEX = /\[([^\]]+)\]\(([^)]+)\)/g;

/**
 * Parse markdown content into sections
 * @param content - The markdown content
 * @returns Array of top-level sections
 */
export function parse_markdown(content: string): MarkdownSection[] {
  const lines = content.split('\n');
  const sections: MarkdownSection[] = [];
  const stack: { level: number; section: MarkdownSection }[] = [];
  
  let currentText: string[] = [];
  let inCodeBlock = false;
  
  for (const line of lines) {
    // Track code blocks to ignore headings inside them
    if (line.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      currentText.push(line);
      continue;
    }
    
    if (inCodeBlock) {
      currentText.push(line);
      continue;
    }
    
    const match = line.match(HEADING_REGEX);
    
    if (match) {
      const level = match[1].length;
      const title = match[2].trim();
      
      // Save text for previous section
      if (stack.length > 0) {
        stack[stack.length - 1].section.text += currentText.join('\n');
        currentText = [];
      }
      
      const section: MarkdownSection = {
        level,
        title,
        text: '',
        children: [],
      };
      
      // Pop stack until we find parent level
      while (stack.length > 0 && stack[stack.length - 1].level >= level) {
        stack.pop();
      }
      
      if (stack.length === 0) {
        sections.push(section);
      } else {
        stack[stack.length - 1].section.children.push(section);
      }
      
      stack.push({ level, section });
    } else {
      currentText.push(line);
    }
  }
  
  // Add remaining text to last section
  if (stack.length > 0) {
    stack[stack.length - 1].section.text += currentText.join('\n');
  }
  
  return sections;
}

/**
 * Build a node from a markdown section
 * @param section - The parsed section
 * @param parentId - The parent node's id
 * @param level - The node level
 * @returns The constructed node
 */
function build_node(section: MarkdownSection, parentId: string, level: number): Node {
  const id = parentId === '/' ? `/${section.title}` : `${parentId}/${section.title}`;
  const links = extract_links(section.text);
  
  return {
    id,
    text: section.text,
    title: section.title,
    summary: '', // Will be filled during summarization
    level,
    children: section.children.map(child => build_node(child, id, level + 1)),
    links,
  };
}

/**
 * Extract links from markdown text
 * @param text - The markdown text
 * @returns Array of Link objects
 */
function extract_links(text: string): Link[] {
  const links: Link[] = [];
  let match;
  
  // Reset regex
  LINK_REGEX.lastIndex = 0;
  
  while ((match = LINK_REGEX.exec(text)) !== null) {
    const comment = match[1];
    const target = match[2];
    
    // Determine target type
    if (target.startsWith('http://') || target.startsWith('https://')) {
      links.push({
        target_type: 'url',
        url: target,
        comment,
      });
    } else if (target.startsWith('/') || target.startsWith('./') || target.startsWith('../')) {
      // Could be a file path or node reference
      // For now, treat as file path (stubs only)
      links.push({
        target_type: 'file',
        file_path: target,
        comment,
      });
    } else {
      // Assume it's a node reference
      links.push({
        target_type: 'node',
        node_id: target,
        comment,
      });
    }
  }
  
  return links;
}

/**
 * Get all nodes in bottom-up order (deepest first)
 * @param node - The root node
 * @returns Array of nodes in bottom-up order
 */
export function get_bottom_up_nodes(node: Node): Node[] {
  const result: Node[] = [];
  
  function traverse(n: Node) {
    for (const child of n.children) {
      traverse(child);
    }
    result.push(n);
  }
  
  traverse(node);
  return result;
}

/**
 * Generate summary for a node using A-N-C-E context
 * This is a placeholder - actual LLM summarization should be injected
 * @param ancestors - Array of ancestor texts
 * @param nodeText - The node's own text
 * @param descendantSummaries - Summaries of descendants
 * @param agentBehavior - Optional agent behavior context
 * @returns Generated summary
 */
export function generate_summary(
  ancestors: string[],
  nodeText: string,
  descendantSummaries: string[],
  agentBehavior?: string
): string {
  // A-N-C-E context building
  const parts: string[] = [];
  
  // A: Ancestor context
  if (ancestors.length > 0) {
    parts.push(`## Ancestors\n${ancestors.join('\n\n')}`);
  }
  
  // N: Node content
  parts.push(`## Content\n${nodeText}`);
  
  // C: Descendant summaries
  if (descendantSummaries.length > 0) {
    parts.push(`## Related Topics\n${descendantSummaries.join('\n\n')}`);
  }
  
  // E: Agent behavior context
  if (agentBehavior) {
    parts.push(`## Agent Behavior\n${agentBehavior}`);
  }
  
  // For now, return a simple summary
  // In production, this would call an LLM
  const firstParagraph = nodeText.split('\n\n')[0] || nodeText.slice(0, 200);
  return firstParagraph.trim().slice(0, 500) + (firstParagraph.length > 500 ? '...' : '');
}

/**
 * Compile a markdown file into a mindmap
 * @param mdPath - Path to the markdown file
 * @param cwd - Current working directory (for resolving paths)
 * @returns Compiled mindmap JSON
 */
export function compile_mindmap(mdPath: string, cwd?: string): MindmapJSON {
  const absolutePath = path.resolve(cwd || process.cwd(), mdPath);
  const content = fs.readFileSync(absolutePath, 'utf-8');
  const dir = path.dirname(absolutePath);
  
  // Parse markdown into sections
  const sections = parse_markdown(content);
  
  // Build root node (represents the entire file)
  const fileName = path.basename(absolutePath, path.extname(absolutePath));
  const root: Node = {
    id: '/',
    text: content,
    title: fileName,
    summary: '',
    level: 0,
    children: sections.map(s => build_node(s, '/', 1)),
    links: [],
  };
  
  // Generate summaries bottom-up
  summarize_bottom_up(root);
  
  // Compute hash of original markdown
  const hash = compute_file_hash(absolutePath);
  
  const now = new Date();
  
  return {
    dir,
    hash,
    compiled_at: now.toISOString(),
    updated_at: now.toISOString(),
    root,
  };
}

/**
 * Recursively summarize nodes from bottom up
 * @param node - The node to process
 * @param ancestorTexts - Texts of ancestors (for A-N-C-E)
 */
function summarize_bottom_up(node: Node, ancestorTexts: string[] = []): void {
  // First, process all children (bottom-up)
  const childTexts = [node.text, ...ancestorTexts];
  for (const child of node.children) {
    summarize_bottom_up(child, childTexts);
  }
  
  // Get descendant summaries (C in A-N-C-E)
  const descendantSummaries = node.children.map(c => c.summary).filter(s => s);
  
  // Generate summary for this node
  node.summary = generate_summary(
    ancestorTexts,
    node.text,
    descendantSummaries
  );
}

/**
 * Compile from markdown content string (for testing)
 * @param content - Markdown content
 * @param fileName - Name for the root node
 * @returns Compiled mindmap
 */
export function compile_mindmap_from_content(content: string, fileName: string = 'root'): MindmapJSON {
  const sections = parse_markdown(content);
  
  const root: Node = {
    id: '/',
    text: content,
    title: fileName,
    summary: '',
    level: 0,
    children: sections.map(s => build_node(s, '/', 1)),
    links: [],
  };
  
  summarize_bottom_up(root);
  
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const now = new Date();
  
  return {
    dir: '',
    hash,
    compiled_at: now.toISOString(),
    updated_at: now.toISOString(),
    root,
  };
}
