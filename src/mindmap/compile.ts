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
 * Count nodes that need processing (have empty summary)
 */
function count_incomplete_nodes(node: Node): number {
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
 * Lock file interface for progressive compilation
 */
interface LockFile {
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
function get_lock_path(outFile: string): string {
  return `${outFile}.lock`;
}

/**
 * Create a lock file
 */
function create_lock(outFile: string, mdPath: string, hash: string): LockFile {
  const lock: LockFile = {
    started_at: new Date().toISOString(),
    source_file: mdPath,
    source_hash: hash,
    output_file: outFile,
  };
  const lockPath = get_lock_path(outFile);
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2));
  return lock;
}

/**
 * Try to read existing lock file
 */
function try_read_lock(outFile: string): LockFile | null {
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
function is_lock_fresh(lock: LockFile): boolean {
  const startedAt = new Date(lock.started_at).getTime();
  return Date.now() - startedAt < LOCK_FRESHNESS_MS;
}

/**
 * Remove lock file
 */
function remove_lock(outFile: string): void {
  const lockPath = get_lock_path(outFile);
  if (fs.existsSync(lockPath)) {
    fs.unlinkSync(lockPath);
  }
}

/**
 * Merge existing node data (summary, links) into a new node tree
 * Preserves already-computed summaries when resuming
 */
function merge_existing_data(newNode: Node, existingNode: Node | null): void {
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
          (l.target_type === 'node' && l.node_id === link.node_id))
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
 * Try to load existing mindmap for continuation
 */
function try_load_existing_mindmap(outFile: string): MindmapJSON | null {
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
 * Compile a markdown file into a mindmap
 * Uses lock-based progressive compilation:
 * - Creates lock file before starting
 * - If fresh lock exists with matching hash, resumes from existing mindmap
 * - Saves progress after each node
 * - Removes lock on successful completion
 * @param mdPath - Path to the markdown file (relative to cwd)
 * @param cwd - Current working directory (for resolving paths)
 * @param outputPath - Optional output JSON path (relative to cwd)
 * @param force - If true, ignore lock and compile from scratch
 * @returns Compiled mindmap JSON
 */
export async function compile_mindmap(
  mdPath: string,
  cwd?: string,
  outputPath?: string,
  force: boolean = false
): Promise<MindmapJSON> {
  const workDir = cwd || process.cwd();
  const absolutePath = path.resolve(workDir, mdPath);
  const content = fs.readFileSync(absolutePath, 'utf-8');
  const dir = path.dirname(absolutePath);

  const hash = compute_file_hash(absolutePath);

  const defaultOutput = path.join(workDir, '.mycc', 'mindmap.json');
  const outFile = outputPath ? path.resolve(workDir, outputPath) : defaultOutput;

  const outDir = path.dirname(outFile);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  // Lock handling
  let shouldResume = false;
  let existingMindmap: MindmapJSON | null = null;

  if (!force) {
    const existingLock = try_read_lock(outFile);

    if (existingLock && is_lock_fresh(existingLock) && existingLock.source_hash === hash) {
      // Fresh lock with matching hash - try to resume
      existingMindmap = try_load_existing_mindmap(outFile);
      if (existingMindmap && existingMindmap.hash === hash) {
        shouldResume = true;
        console.log('[mindmap] Fresh lock found, resuming from previous compilation');
      } else {
        console.log('[mindmap] Lock exists but mindmap invalid, starting fresh');
        remove_lock(outFile);
      }
    } else if (existingLock && !is_lock_fresh(existingLock)) {
      console.log('[mindmap] Stale lock (>3h old), starting fresh');
      remove_lock(outFile);
    } else if (existingLock && existingLock.source_hash !== hash) {
      console.log('[mindmap] Lock for different source version, starting fresh');
      remove_lock(outFile);
    }
  } else {
    remove_lock(outFile);
  }

  // Create lock file
  create_lock(outFile, mdPath, hash);

  // Parse markdown
  const sections = parse_markdown(content);
  const fileName = path.basename(absolutePath, path.extname(absolutePath));

  const firstHeadingMatch = content.match(/^#{1,6}\s+/m);
  const preamble = firstHeadingMatch
    ? content.slice(0, content.indexOf(firstHeadingMatch[0])).trim()
    : content.trim();

  // Build new tree
  const root: Node = {
    id: '/',
    text: preamble,
    title: fileName,
    summary: '',
    level: 0,
    children: sections.map((s) => build_node(s, '/', 1)),
    links: extract_links(preamble),
  };

  // Merge existing data if resuming
  if (shouldResume && existingMindmap) {
    merge_existing_data(root, existingMindmap.root);
  }

  // Create mindmap
  const now = new Date();
  const mindmap: MindmapJSON = {
    dir,
    source_file: mdPath,
    hash,
    compiled_at: shouldResume && existingMindmap ? existingMindmap.compiled_at : now.toISOString(),
    updated_at: now.toISOString(),
    root,
  };

  // Count incomplete nodes
  const incompleteNodes = count_incomplete_nodes(root);
  const totalNodes = count_nodes(root);
  const skippedNodes = totalNodes - incompleteNodes;

  if (skippedNodes > 0) {
    console.log(`[mindmap] ${skippedNodes}/${totalNodes} nodes already complete`);
  }

  // If all complete, finish early
  if (incompleteNodes === 0) {
    console.log(`[mindmap] All ${totalNodes} nodes already summarized`);
    remove_lock(outFile);
    return mindmap;
  }

  let processedNodes = 0;
  const onNodeStart = () => { processedNodes++; };
  const onProgress = (round: number, tool: string) => {
    const percent = Math.round((processedNodes / incompleteNodes) * 100);
    const bar = '█'.repeat(Math.floor(percent / 5)) + '░'.repeat(20 - Math.floor(percent / 5));
    process.stdout.write(
      `\r\x1b[2K[mindmap] [${bar}] ${processedNodes}/${incompleteNodes} (${tool}, r${round})`
    );
  };
  const onNodeComplete = () => {
    mindmap.updated_at = new Date().toISOString();
    fs.writeFileSync(outFile, JSON.stringify(mindmap, null, 2));
  };

  await summarize_with_explorer(root, workDir, [], onProgress, onNodeStart, onNodeComplete);

  process.stdout.write('\r\x1b[2K');

  // Final save and remove lock
  mindmap.updated_at = new Date().toISOString();
  fs.writeFileSync(outFile, JSON.stringify(mindmap, null, 2));
  remove_lock(outFile);

  console.log(`[mindmap] Completed ${totalNodes} nodes`);
  return mindmap;
}

/**
 * Recursively summarize nodes using explorer agent
 * Skips nodes that already have summaries (for resume capability)
 * @param node - The node to process
 * @param workDir - Working directory for file operations
 * @param ancestorTexts - Texts of ancestors (for context)
 * @param onProgress - Progress callback for tool usage
 * @param onNodeStart - Callback called BEFORE processing each node (for accurate progress)
 * @param onNodeComplete - Callback called AFTER each node is complete (to save progress)
 */
async function summarize_with_explorer(
  node: Node,
  workDir: string,
  ancestorTexts: string[] = [],
  onProgress?: (round: number, tool: string) => void,
  onNodeStart?: () => void,
  onNodeComplete?: () => void
): Promise<void> {
  // First, process all children (bottom-up)
  const childTexts = [node.text, ...ancestorTexts];
  for (const child of node.children) {
    await summarize_with_explorer(child, workDir, childTexts, onProgress, onNodeStart, onNodeComplete);
  }

  // Skip if already summarized (resume capability)
  if (node.summary !== '') {
    return;
  }

  // Call start callback BEFORE processing this node
  if (onNodeStart) {
    onNodeStart();
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

  // Convert marked files to Link objects and append to node.links
  for (const filePath of result.markedFiles) {
    node.links.push({
      target_type: 'file',
      file_path: filePath,
      comment: `Discovered during exploration`,
    });
  }

  // Convert marked URLs to Link objects and append to node.links
  for (const url of result.markedUrls) {
    node.links.push({
      target_type: 'url',
      url,
      comment: `Discovered during exploration`,
    });
  }

  // Call complete callback AFTER this node is fully processed
  if (onNodeComplete) {
    onNodeComplete();
  }
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
    links: extract_links(preamble),
  };

  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const now = new Date();

  const mindmap: MindmapJSON = {
    dir: '',
    source_file: '', // No source file for content-based compilation
    hash,
    compiled_at: now.toISOString(),
    updated_at: now.toISOString(),
    root,
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

    // Note: For content-based compilation, we don't save to file on each node
    // since there's no output file specified
    await summarize_with_explorer(root, process.cwd(), [], onProgress, onNodeStart);
    process.stdout.write('\r\x1b[2K');
  } else {
    await summarize_with_explorer(root, process.cwd());
  }

  // Update timestamp after completion
  mindmap.updated_at = new Date().toISOString();

  return mindmap;
}