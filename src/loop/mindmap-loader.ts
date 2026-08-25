/**
 * mindmap-loader.ts - Load the project mindmap (mindmap.json + replay patches)
 *
 * Extracted from agent-repl.ts to isolate mindmap bootstrap (load + validate +
 * patch replay) from the REPL entry-point orchestration.
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { get_default_mindmap_path, load_mindmap, validate_mindmap, applyPatchAction, readAllPatches, getPatchPath } from '../mindmap/index.js';
import type { Node, Mindmap } from '../mindmap/types.js';
import type { CoreModule } from '../types.js';

/**
 * Count nodes in a mindmap tree (recursive).
 */
function countNodes(node: Node): number {
  let count = 1;
  for (const child of node.children) {
    count += countNodes(child);
  }
  return count;
}

/**
 * Load mindmap.json then replay hash-matched patches from mindmap-patch.jsonl.
 *
 * Two independent on-disk lines merge only in memory at load time:
 * 1. mindmap.json — MYCC.md isomorph (load_mindmap sets is_mycc=true, is_patch=false)
 * 2. mindmap-patch.jsonl — append-only patch log from recap
 *
 * Patches are hash-gated: only those whose mindmap_hash matches the loaded
 * mindmap.json hash are applied (others are skipped — created against an older
 * version). See docs/mindmap-redesign.md Part 3.
 */
function loadMindmapWithPatches(mindmapPath: string, workDir: string): Mindmap {
  const mindmap = load_mindmap(mindmapPath);

  // Replay patches from jsonl (hash-gated)
  const patchPath = getPatchPath(workDir);
  if (fs.existsSync(patchPath)) {
    const patches = readAllPatches(patchPath);
    let applied = 0;
    let skipped = 0;
    for (const patch of patches) {
      // Skip patches created against a different mindmap.json version
      if (patch.mindmap_hash !== mindmap.hash) {
        skipped++;
        continue;
      }
      if (applyPatchAction(mindmap, patch)) {
        applied++;
      } else {
        skipped++;
      }
    }
    if (applied > 0 || skipped > 0) {
      console.log(chalk.gray(`[mindmap] Replayed ${applied} patches (${skipped} skipped)`));
    }
  }

  return mindmap;
}

/**
 * Load the project mindmap from `workDir`, validate it against MYCC.md, and
 * install it on the agent context. Returns true if a mindmap was loaded
 * (so the caller can choose the right project-context injection path),
 * false if no mindmap.json exists or loading failed.
 *
 * @param workDir - Project working directory (locates mindmap.json + patch jsonl)
 * @param core - Agent core module (setMindmap installs the loaded mindmap)
 */
export function loadProjectMindmap(workDir: string, core: CoreModule): boolean {
  const mindmapPath = get_default_mindmap_path(workDir);

  if (!fs.existsSync(mindmapPath)) {
    console.log(chalk.yellow('[mindmap] No mindmap found. LLM will read MYCC.md directly.'));
    return false;
  }

  try {
    const mindmap = loadMindmapWithPatches(mindmapPath, workDir);

    // Validate against MYCC.md (existing hash-check logic preserved)
    const claudeMdPath = path.join(workDir, 'MYCC.md');
    if (fs.existsSync(claudeMdPath) && !validate_mindmap(mindmap, claudeMdPath)) {
      // Validation failed - show warning but continue loading
      console.log(chalk.yellow('[mindmap] Validation failed (outdated). Loading anyway.'));
    } else {
      // Success
      console.log(chalk.gray(`[mindmap] Loaded: ${countNodes(mindmap.root)} nodes`));
    }

    core.setMindmap(mindmap);
    return true;
  } catch (err) {
    console.log(chalk.red(`[mindmap] Failed to load: ${(err as Error).message}`));
    return false;
  }
}