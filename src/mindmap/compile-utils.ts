/**
 * compile-utils.ts - Utility functions for mindmap compilation
 */

import * as fs from 'fs';
import type { Node, MarkdownSection, Link, MindmapJSON } from './types.js';
import { safeNodeId } from '../utils/sanitize.js';

/**
 * Regular expressions for markdown parsing
 */
const HEADING_REGEX = /^(#{1,6})\s+(.+)$/m;
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
export function build_node(section: MarkdownSection, parentId: string, level: number): Node {
  // Create safe ID from title using utility function
  const safeTitle = safeNodeId(section.title);
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
export function extract_links(text: string): Link[] {
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
export function count_nodes(node: Node): number {
  let count = 1;
  for (const child of node.children) {
    count += count_nodes(child);
  }
  return count;
}

/**
 * Count nodes that need processing (have empty summary)
 */
export function count_incomplete_nodes(node: Node): number {
  let count = 0;
  if (node.summary === '') {
    count = 1;
  }
  for (const child of node.children) {
    count += count_incomplete_nodes(child);
  }
  return count;
}

/**
 * Collect all nodes in bottom-up order (leaves first, root last)
 * This ensures children are processed before parents
 */
export function collect_nodes_bottom_up(node: Node): Node[] {
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
 * Merge existing node data (summary, links) into a new node tree
 * Preserves already-computed summaries when resuming
 */
export function merge_existing_data(newNode: Node, existingNode: Node | null): void {
  if (!existingNode) return;

  // Copy existing summary if present
  if (existingNode.summary) {
    newNode.summary = existingNode.summary;
  }

  // Merge links (deduplicated)
  for (const link of existingNode.links || []) {
    const exists = newNode.links.some(
      (l) =>
        l.target_type === link.target_type &&
        l.comment === link.comment &&
        ((l.target_type === 'url' && l.url === link.url) ||
          (l.target_type === 'file' && l.file_path === link.file_path) ||
          (l.target_type === 'node' && l.node_id === link.node_id) ||
          (l.target_type === 'term' && l.term_name === link.term_name))
    );
    if (!exists) {
      newNode.links.push(link);
    }
  }

  // Recursively merge children by id
  for (const newChild of newNode.children) {
    const existingChild = existingNode.children?.find((c) => c.id === newChild.id);
    if (existingChild) {
      merge_existing_data(newChild, existingChild);
    }
  }
}

/**
 * Lock file interface for progressive compilation
 */
export interface LockFile {
  started_at: string;
  source_file: string;
  source_hash: string;
  output_file: string;
}

/** Lock freshness threshold in milliseconds (3 hours) */
const LOCK_FRESHNESS_MS = 3 * 60 * 60 * 1000;

/**
 * Get lock file path
 */
export function get_lock_path(outFile: string): string {
  return `${outFile}.lock`;
}

/**
 * Create a lock file
 */
export function create_lock(outFile: string, mdPath: string, hash: string): LockFile {
  const lock: LockFile = {
    started_at: new Date().toISOString(),
    source_file: mdPath,
    source_hash: hash,
    output_file: outFile,
  };
  const lockPath = get_lock_path(outFile);
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2), 'utf-8');
  return lock;
}

/**
 * Try to read existing lock file
 */
export function try_read_lock(outFile: string): LockFile | null {
  try {
    const lockPath = get_lock_path(outFile);
    if (!fs.existsSync(lockPath)) return null;
    const content = fs.readFileSync(lockPath, 'utf-8');
    return JSON.parse(content) as LockFile;
  } catch {
    return null;
  }
}

/**
 * Check if lock is fresh (within threshold)
 */
export function is_lock_fresh(lock: LockFile): boolean {
  const startedAt = new Date(lock.started_at).getTime();
  return Date.now() - startedAt < LOCK_FRESHNESS_MS;
}

/**
 * Remove lock file
 */
export function remove_lock(outFile: string): void {
  const lockPath = get_lock_path(outFile);
  if (fs.existsSync(lockPath)) {
    fs.unlinkSync(lockPath);
  }
}

/**
 * Try to load existing mindmap for continuation
 */
export function try_load_existing_mindmap(outFile: string): MindmapJSON | null {
  try {
    if (!fs.existsSync(outFile)) return null;
    const content = fs.readFileSync(outFile, 'utf-8');
    const json = JSON.parse(content) as MindmapJSON;
    if (!json.root || !json.hash) return null;
    return json;
  } catch {
    return null;
  }
}

/**
 * Active operation being processed
 */
export interface ActiveOp {
  nodeTitle: string;
  level: number;
  round: number;
  tool: string;
  args: Record<string, unknown>;
}

/**
 * Progress tracker that handles concurrent updates correctly
 * Tracks all active operations and renders a fixed 4-line display
 */
export class ProgressTracker {
  private processed: number = 0;
  private activeOps: Map<string, ActiveOp> = new Map();
  private renderQueued: boolean = false;
  private firstUpdate: boolean = true;
  private finished: boolean = false;

  constructor(
    private total: number,
    private readonly maxDisplay: number = 3
  ) {}

  /**
   * Called when a node starts processing
   */
  onNodeStart(_nodeTitle: string): void {
    this.processed++;
    this.queueRender();
  }

  /**
   * Called when progress is reported for a node
   */
  onProgress(nodeTitle: string, level: number, round: number, tool: string, args: Record<string, unknown>): void {
    this.activeOps.set(nodeTitle, { nodeTitle, level, round, tool, args });
    this.queueRender();
  }

  /**
   * Called when a node completes
   */
  onNodeComplete(nodeTitle: string): void {
    this.activeOps.delete(nodeTitle);
    this.queueRender();
  }

  /**
   * Called when processing is complete - cancels pending renders
   */
  finish(): void {
    this.finished = true;
    this.activeOps.clear();
  }

  /**
   * Queue a render (debounced but ensures first update renders immediately)
   */
  private queueRender(): void {
    if (this.finished) return;

    if (this.firstUpdate) {
      this.firstUpdate = false;
      this.render();
      return;
    }

    if (this.renderQueued) return;
    this.renderQueued = true;

    // Use setImmediate to batch concurrent updates
    setImmediate(() => {
      this.renderQueued = false;
      if (this.finished) return;
      this.render();
    });
  }

  /**
   * Render the fixed 4-line display
   */
  private render(): void {
    const percent = Math.round((this.processed / this.total) * 100);
    const bar = '█'.repeat(Math.floor(percent / 5)) + '░'.repeat(20 - Math.floor(percent / 5));

    // Get top N operations for display
    const ops = Array.from(this.activeOps.values()).slice(0, this.maxDisplay);

    const lines: string[] = [];
    lines.push(`[mindmap] [${bar}] ${this.processed}/${this.total}`);

    for (let i = 0; i < this.maxDisplay; i++) {
      if (i < ops.length) {
        const op = ops[i];
        const heading = '#'.repeat(op.level);
        // Pad title to align round column: total heading+title width = 22
        const title = op.nodeTitle.slice(0, 22 - op.level).padEnd(22 - op.level);
        const round = op.round.toString().padEnd(2);
        const argDisplay = formatToolArg(op.tool, op.args).slice(0, 30);
        lines.push(`${heading} ${title} r${round}  ${op.tool}(${argDisplay})`);
      } else {
        lines.push('');
      }
    }

    // Move cursor up 4 lines, clear, then write all lines
    process.stdout.write(`\x1b[4A${lines.map((l) => `\x1b[2K${l}`).join('\n')}\n`);
  }
}

/**
 * Format tool args for display - extract the most relevant arg
 */
export function formatToolArg(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case 'read_file':
      return String(args.path || '').slice(0, 30);
    case 'ls':
      return String(args.path || '.').slice(0, 20);
    case 'grep':
      return `pattern:"${String(args.pattern || '').slice(0, 20)}"`;
    case 'mark_file':
      return String(args.path || '').slice(0, 30);
    case 'web_search':
      return `"${String(args.query || '').slice(0, 20)}"`;
    case 'web_fetch':
      return String(args.url || '').slice(0, 30);
    case 'mark_url':
      return String(args.url || '').slice(0, 30);
    case 'mark_term':
      return `"${String(args.term || '').slice(0, 20)}"`;
    default:
      return '';
  }
}

/**
 * Render progress bar and active operations
 */
export function renderProgress(
  processed: number,
  total: number,
  activeOps: ActiveOp[]
): string {
  const percent = Math.round((processed / total) * 100);
  const bar = '█'.repeat(Math.floor(percent / 5)) + '░'.repeat(20 - Math.floor(percent / 5));

  const lines: string[] = [];
  lines.push(`[mindmap] [${bar}] ${processed}/${total}`);

  for (let i = 0; i < 3; i++) {
    if (i < activeOps.length) {
      const op = activeOps[i];
      const heading = '#'.repeat(op.level);
      const title = op.nodeTitle.slice(0, 22 - op.level).padEnd(22 - op.level);
      const round = op.round.toString().padEnd(2);
      const argDisplay = formatToolArg(op.tool, op.args).slice(0, 30);
      lines.push(`${heading} ${title} r${round}  ${op.tool}(${argDisplay})`);
    } else {
      lines.push('');
    }
  }

  // Move cursor up 3 lines, then write all lines
  return `\x1b[3A${lines.map((l) => `\x1b[2K${l}`).join('\n')}\n`;
}