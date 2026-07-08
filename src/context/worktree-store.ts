/**
 * worktree-store.ts - Query git worktrees via `git worktree list --porcelain`
 *
 * Worktrees are NOT persisted to a JSON file. They are always queried live
 * from git, which is the single source of truth. The teammate→worktree
 * mapping is derived by convention: the worktree directory name equals the
 * teammate name (enforced in tm_create.ts).
 */

import { exec } from 'child_process';
import * as path from 'path';
import type { WorkTree } from '../types.js';

/**
 * Raw info parsed from `git worktree list --porcelain`
 */
interface GitWorktreeInfo {
  path: string;
  commit: string;
  branch: string | null;
}

/**
 * Parse `git worktree list --porcelain` output into structured records.
 */
function parseGitWorktreeList(output: string): GitWorktreeInfo[] {
  const worktrees: GitWorktreeInfo[] = [];
  const lines = output.split('\n');
  let current: Partial<GitWorktreeInfo> | null = null;

  for (const line of lines) {
    if (line.startsWith('worktree ')) {
      if (current && current.path) {
        worktrees.push(current as GitWorktreeInfo);
      }
      current = { path: line.substring(9) };
    } else if (line.startsWith('HEAD ')) {
      if (current) current.commit = line.substring(5);
    } else if (line.startsWith('branch ')) {
      if (current) current.branch = line.substring(7);
    }
  }

  // Add last worktree
  if (current && current.path) {
    worktrees.push(current as GitWorktreeInfo);
  }

  return worktrees;
}

/**
 * Run `git worktree list --porcelain` in the given directory.
 * Returns the raw stdout string, or empty string on failure.
 */
function execGitWorktreeList(workDir: string): Promise<string> {
  return new Promise((resolve) => {
    exec(
      'git worktree list --porcelain',
      { cwd: workDir, encoding: 'utf-8' },
      (err, stdout) => {
        if (err) {
          // Git not available, not a repo, or no worktrees — return empty
          resolve('');
        } else {
          resolve(stdout || '');
        }
      },
    );
  });
}

/**
 * List all git worktrees (excluding the main worktree).
 *
 * Only worktrees whose path contains `.worktrees` are tracked — this is the
 * mycc convention for parallel branch work. User-created worktrees outside
 * `.worktrees/` are ignored.
 *
 * The `name` field is derived from `path.basename(worktree.path)`, which by
 * convention equals the teammate name.
 *
 * @param workDir - The project working directory (defaults to process.cwd())
 * @returns Array of worktree records (empty if none or git unavailable)
 */
export async function listWorktrees(workDir?: string): Promise<WorkTree[]> {
  const cwd = workDir || process.cwd();
  const output = await execGitWorktreeList(cwd);
  if (!output) return [];

  const gitWorktrees = parseGitWorktreeList(output);
  const result: WorkTree[] = [];

  for (const wt of gitWorktrees) {
    // Skip the main worktree (project root)
    if (wt.path === cwd) continue;

    // Skip worktrees outside .worktrees directory (user-created, not tracked)
    if (!wt.path.includes('.worktrees')) continue;

    const name = path.basename(wt.path);
    const branch = wt.branch ? path.basename(wt.branch) : 'detached';

    result.push({
      name,
      path: wt.path,
      branch,
    });
  }

  return result;
}

/**
 * Find a worktree by its name (directory basename, conventionally the
 * teammate name).
 *
 * @param name - The worktree name to search for
 * @param workDir - The project working directory (defaults to process.cwd())
 * @returns The matching worktree, or undefined if not found
 */
export async function findWorktreeByName(
  name: string,
  workDir?: string,
): Promise<WorkTree | undefined> {
  const worktrees = await listWorktrees(workDir);
  return worktrees.find((wt) => wt.name === name);
}

/**
 * Find a worktree by its path.
 *
 * Matches when the worktree path exactly equals `targetPath`, or when
 * `targetPath` is inside the worktree directory (prefix match with separator).
 *
 * @param targetPath - The path to search for (absolute or relative)
 * @param workDir - The project working directory (defaults to process.cwd())
 * @returns The matching worktree, or undefined if not found
 */
export async function findWorktreeByPath(
  targetPath: string,
  workDir?: string,
): Promise<WorkTree | undefined> {
  const worktrees = await listWorktrees(workDir);
  return worktrees.find(
    (wt) =>
      targetPath === wt.path || targetPath.startsWith(wt.path + path.sep),
  );
}