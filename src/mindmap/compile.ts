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
import type { MindmapJSON, Node } from './types.js';
import { compute_file_hash } from './validate.js';
import {
  parse_markdown,
  build_node,
  extract_links,
  count_nodes,
  count_incomplete_nodes,
  merge_existing_data,
  create_lock,
  try_read_lock,
  is_lock_fresh,
  remove_lock,
  try_load_existing_mindmap,
  ActiveOp,
  renderProgress,
  summarize_with_explorer,
} from './compile-utils.js';

// Re-export for backward compatibility (tests import directly from compile.js)
export { parse_markdown, get_bottom_up_nodes } from './compile-utils.js';

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

  // Parse markdown and build tree
  const sections = parse_markdown(content);
  const fileName = path.basename(absolutePath, path.extname(absolutePath));

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

  // Progress tracking
  let processedNodes = 0;
  const activeOps: ActiveOp[] = [];

  const onNodeStart = (_nodeTitle: string) => {
    processedNodes++;
  };

  const onProgress = (nodeTitle: string, round: number, tool: string, args: Record<string, unknown>) => {
    // Update or add operation for this node
    const existingIdx = activeOps.findIndex((op) => op.nodeTitle === nodeTitle);
    if (existingIdx >= 0) {
      activeOps[existingIdx] = { nodeTitle, round, tool, args };
    } else {
      activeOps.push({ nodeTitle, round, tool, args });
      if (activeOps.length > 3) {
        activeOps.shift();
      }
    }
    process.stdout.write(renderProgress(processedNodes, incompleteNodes, activeOps));
  };

  const onNodeComplete = () => {
    mindmap.updated_at = new Date().toISOString();
    fs.writeFileSync(outFile, JSON.stringify(mindmap, null, 2));
  };

  // Print initial empty lines for progress display
  process.stdout.write('\n\n\n');

  try {
    await summarize_with_explorer(root, workDir, onProgress, onNodeStart, onNodeComplete);
  } catch (err) {
    process.stdout.write('\x1b[3A\x1b[J');
    remove_lock(outFile);
    throw err;
  }

  // Clean up and finalize
  process.stdout.write('\x1b[3A\x1b[J');
  mindmap.updated_at = new Date().toISOString();
  fs.writeFileSync(outFile, JSON.stringify(mindmap, null, 2));
  remove_lock(outFile);

  console.log(`[mindmap] Completed ${totalNodes} nodes`);
  return mindmap;
}

/**
 * Compile from markdown content string (for testing)
 */
export async function compile_mindmap_from_content(
  content: string,
  fileName: string = 'root',
  showProgress: boolean = false
): Promise<MindmapJSON> {
  const sections = parse_markdown(content);

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
    source_file: '',
    hash,
    compiled_at: now.toISOString(),
    updated_at: now.toISOString(),
    root,
  };

  if (showProgress) {
    const totalNodes = count_nodes(root);
    let currentNode = 0;
    const activeOps: ActiveOp[] = [];

    const onNodeStart = (_nodeTitle: string) => {
      currentNode++;
    };

    const onProgress = (nodeTitle: string, round: number, tool: string, args: Record<string, unknown>) => {
      const existingIdx = activeOps.findIndex((op) => op.nodeTitle === nodeTitle);
      if (existingIdx >= 0) {
        activeOps[existingIdx] = { nodeTitle, round, tool, args };
      } else {
        activeOps.push({ nodeTitle, round, tool, args });
        if (activeOps.length > 3) activeOps.shift();
      }
      process.stdout.write(renderProgress(currentNode, totalNodes, activeOps));
    };

    process.stdout.write('\n\n\n');
    await summarize_with_explorer(root, process.cwd(), onProgress, onNodeStart);
    process.stdout.write('\x1b[3A\x1b[J');
  } else {
    await summarize_with_explorer(root, process.cwd());
  }

  mindmap.updated_at = new Date().toISOString();
  return mindmap;
}