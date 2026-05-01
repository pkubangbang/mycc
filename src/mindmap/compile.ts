/**
 * compile.ts - Compile markdown into mindmap
 * @see docs/mindmap-design.md
 *
 * Compilation process:
 * 1. Parse markdown into sections by heading hierarchy
 * 2. Build tree structure from sections
 * 3. Generate summaries using explorer agent (autonomous code exploration)
 * 4. Compute hash and return mindmap
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { MindmapJSON, Node, MarkdownSection, Link } from './types.js';
import { compute_file_hash } from './validate.js';
import { summarizeWithExplorer } from './explorer-agent.js';

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
  const rootSections: MarkdownSection[] = [];
  const stack: { level: number; section: MarkdownSection }[] = [];

  let currentText: string[] = [];
  let inCodeBlock = false;

  // Helper to save current text to the section at top of stack
  const saveCurrentText = () => {
    if (stack.length > 0 && currentText.length > 0) {
      stack[stack.length - 1].section.text += currentText.join('\n');
      currentText = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

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

      // Save text to previous section before starting new one
      saveCurrentText();

      const section: MarkdownSection = {
        level,
        title,
        text: '', // Will be filled with content below this heading
        children: [],
      };

      // Pop stack until we find the parent level
      while (stack.length > 0 && stack[stack.length - 1].level >= level) {
        stack.pop();
      }

      if (stack.length === 0) {
        // Top-level section
        rootSections.push(section);
      } else {
        // Child of current top of stack
        stack[stack.length - 1].section.children.push(section);
      }

      stack.push({ level, section });
    } else {
      currentText.push(line);
    }
  }

  // Save remaining text to last section
  saveCurrentText();

  return rootSections;
}

/**
 * Build a node from a markdown section
 * @param section - The parsed section
 * @param parentId - The parent node's id
 * @param level - The node level
 * @returns The constructed node
 */
function build_node(section: MarkdownSection, parentId: string, level: number): Node {
  // Create safe ID from title (sanitize special characters)
  const safeTitle = section.title.replace(/[^a-zA-Z0-9_-]/g, '_');
  const id = parentId === '/' ? `/${safeTitle}` : `${parentId}/${safeTitle}`;
  const links = extract_links(section.text);

  return {
    id,
    text: section.text.trim(),
    title: section.title,
    summary: '', // Will be filled during summarization
    level,
    children: section.children.map((child) => build_node(child, id, level + 1)),
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
    } else if (
      target.startsWith('/') ||
      target.startsWith('./') ||
      target.startsWith('../')
    ) {
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
 * Count total nodes in tree
 */
function count_nodes(node: Node): number {
  let count = 1;
  for (const child of node.children) {
    count += count_nodes(child);
  }
  return count;
}

/**
 * Compile a markdown file into a mindmap
 * @param mdPath - Path to the markdown file (relative to cwd)
 * @param cwd - Current working directory (for resolving paths)
 * @param outputPath - Optional output JSON path (relative to cwd)
 *                    If not provided, defaults to .mycc/mindmap.json
 * @returns Compiled mindmap JSON
 */
export async function compile_mindmap(
  mdPath: string,
  cwd?: string,
  outputPath?: string
): Promise<MindmapJSON> {
  const workDir = cwd || process.cwd();
  const absolutePath = path.resolve(workDir, mdPath);
  const content = fs.readFileSync(absolutePath, 'utf-8');
  const dir = path.dirname(absolutePath);

  // Parse markdown into sections
  const sections = parse_markdown(content);

  // Build root node (represents the entire file)
  const fileName = path.basename(absolutePath, path.extname(absolutePath));

  // Extract preamble (content before first heading)
  const firstHeadingMatch = content.match(/^#{1,6}\s+/m);
  const preamble = firstHeadingMatch
    ? content.slice(0, content.indexOf(firstHeadingMatch[0])).trim()
    : content.trim();

  const root: Node = {
    id: '/',
    text: preamble, // Only preamble text for root, not entire file
    title: fileName,
    summary: '',
    level: 0,
    children: sections.map((s) => build_node(s, '/', 1)),
    links: [],
  };

  // Count total nodes for progress bar
  const totalNodes = count_nodes(root);
  let currentNode = 0;

  // Pre-increment callback called BEFORE processing each node
  const onNodeStart = () => {
    currentNode++;
  };

  // Progress callback - uses currentNode which was pre-incremented
  const onProgress = (round: number, tool: string) => {
    const percent = Math.round((currentNode / totalNodes) * 100);
    const bar =
      '█'.repeat(Math.floor(percent / 5)) +
      '░'.repeat(20 - Math.floor(percent / 5));
    process.stdout.write(
      `\r[mindmap] Exploring [${bar}] ${currentNode}/${totalNodes} (${tool}, round ${round})`
    );
  };

  // Generate summaries using explorer agent
  await summarize_with_explorer(root, workDir, [], onProgress, onNodeStart);

  // Clear progress line and show completion
  process.stdout.write('\r\x1b[2K');

  // Compute hash of original markdown
  const hash = compute_file_hash(absolutePath);

  const now = new Date();

  const mindmap: MindmapJSON = {
    dir,
    source_file: mdPath, // Store relative path
    hash,
    compiled_at: now.toISOString(),
    updated_at: now.toISOString(),
    root,
  };

  // Determine output path
  const defaultOutput = path.join(workDir, '.mycc', 'mindmap.json');
  const outFile = outputPath
    ? path.resolve(workDir, outputPath)
    : defaultOutput;

  // Ensure .mycc directory exists for default output
  const outDir = path.dirname(outFile);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  // Save to file
  fs.writeFileSync(outFile, JSON.stringify(mindmap, null, 2));

  return mindmap;
}

/**
 * Recursively summarize nodes using explorer agent
 * @param node - The node to process
 * @param workDir - Working directory for file operations
 * @param ancestorTexts - Texts of ancestors (for context)
 * @param onProgress - Progress callback for tool usage
 * @param onNodeStart - Callback called BEFORE processing each node (for accurate progress)
 */
async function summarize_with_explorer(
  node: Node,
  workDir: string,
  ancestorTexts: string[] = [],
  onProgress?: (round: number, tool: string) => void,
  onNodeStart?: () => void
): Promise<void> {
  // Call start callback BEFORE processing this node (for accurate progress)
  if (onNodeStart) {
    onNodeStart();
  }

  // First, process all children (bottom-up)
  const childTexts = [node.text, ...ancestorTexts];
  for (const child of node.children) {
    await summarize_with_explorer(child, workDir, childTexts, onProgress, onNodeStart);
  }

  // Build ancestor context
  const ancestorContext = ancestorTexts.join('\n\n---\n\n');

  // Generate summary using explorer agent
  const result = await summarizeWithExplorer(
    node.title,
    node.text,
    ancestorContext,
    workDir,
    onProgress
  );
  node.summary = result.summary;
}

/**
 * Compile from markdown content string (for testing)
 * @param content - Markdown content
 * @param fileName - Name for the root node
 * @param showProgress - Whether to show progress bar (default: false for tests)
 * @returns Compiled mindmap
 */
export async function compile_mindmap_from_content(
  content: string,
  fileName: string = 'root',
  showProgress: boolean = false
): Promise<MindmapJSON> {
  const sections = parse_markdown(content);

  // Extract preamble (content before first heading)
  const firstHeadingMatch = content.match(/^#{1,6}\s+/m);
  const preamble = firstHeadingMatch
    ? content.slice(0, content.indexOf(firstHeadingMatch[0])).trim()
    : content.trim();

  const root: Node = {
    id: '/',
    text: preamble,
    title: fileName,
    summary: '',
    level: 0,
    children: sections.map((s) => build_node(s, '/', 1)),
    links: [],
  };

  if (showProgress) {
    // Count total nodes for progress bar
    const totalNodes = count_nodes(root);
    let currentNode = 0;

    const onNodeStart = () => {
      currentNode++;
    };

    const onProgress = (round: number, tool: string) => {
      const percent = Math.round((currentNode / totalNodes) * 100);
      const bar =
        '█'.repeat(Math.floor(percent / 5)) +
        '░'.repeat(20 - Math.floor(percent / 5));
      process.stdout.write(
        `\r[mindmap] Exploring [${bar}] ${currentNode}/${totalNodes} (${tool}, round ${round})`
      );
    };

    await summarize_with_explorer(root, process.cwd(), [], onProgress, onNodeStart);
    process.stdout.write('\r\x1b[2K');
  } else {
    await summarize_with_explorer(root, process.cwd());
  }

  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const now = new Date();

  return {
    dir: '',
    source_file: '', // No source file for content-based compilation
    hash,
    compiled_at: now.toISOString(),
    updated_at: now.toISOString(),
    root,
  };
}