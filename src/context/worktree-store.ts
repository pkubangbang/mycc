/**
 * worktree-store.ts - Persistent worktree storage using JSON
 *
 * Worktrees are project-level resources that persist across sessions.
 * Uses .mycc/worktrees.json for persistence.
 *
 * Features:
 * - Atomic writes (write to temp file, then rename)
 * - Graceful handling of missing files
 * - Date parsing on load
 */

import * as fs from 'fs';
import * as path from 'path';
import type { WorkTree } from '../types.js';
import { getMyccDir } from '../config.js';

const WORKTREES_FILE = 'worktrees.json';

/**
 * Get the path to the worktrees JSON file
 */
function getWorktreesFile(): string {
  return path.join(getMyccDir(), WORKTREES_FILE);
}

/**
 * Get the path to the temp file for atomic writes
 */
function getTempFile(): string {
  return path.join(getMyccDir(), `${WORKTREES_FILE}.tmp`);
}

/**
 * Ensure the worktrees file exists, creating empty array if missing
 */
function ensureFile(): void {
  const file = getWorktreesFile();
  if (!fs.existsSync(file)) {
    // Ensure parent directory exists
    const dir = getMyccDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(file, '[]', 'utf-8');
  }
}

/**
 * Load all worktrees from JSON file
 * Parses date strings back into Date objects
 */
export function loadWorktrees(): WorkTree[] {
  ensureFile();
  const file = getWorktreesFile();
  try {
    const content = fs.readFileSync(file, 'utf-8');
    const data = JSON.parse(content);
    // Parse dates when loading
    return data.map((w: WorkTree) => ({
      ...w,
      createdAt: new Date(w.createdAt),
    }));
  } catch (error) {
    // If JSON is corrupted, return empty array
    console.error('Failed to load worktrees, returning empty array:', error);
    return [];
  }
}

/**
 * Save worktrees to JSON file using atomic write pattern
 * Writes to temp file first, then renames for atomicity
 */
export function saveWorktrees(worktrees: WorkTree[]): void {
  ensureFile();
  const file = getWorktreesFile();
  const tempFile = getTempFile();

  // Write to temp file first
  fs.writeFileSync(tempFile, JSON.stringify(worktrees, null, 2), 'utf-8');

  // Rename temp file to target (atomic on same filesystem)
  fs.renameSync(tempFile, file);
}

/**
 * Add or update a worktree
 * If worktree with same name exists, it will be updated
 */
export function addWorktree(worktree: WorkTree): void {
  const worktrees = loadWorktrees();
  const existing = worktrees.findIndex(w => w.name === worktree.name);
  if (existing >= 0) {
    worktrees[existing] = worktree;
  } else {
    worktrees.push(worktree);
  }
  saveWorktrees(worktrees);
}

/**
 * Remove a worktree by name
 * @returns true if worktree was found and removed, false if not found
 */
export function removeWorktree(name: string): boolean {
  const worktrees = loadWorktrees();
  const index = worktrees.findIndex(w => w.name === name);
  if (index < 0) return false;
  worktrees.splice(index, 1);
  saveWorktrees(worktrees);
  return true;
}

/**
 * Get a worktree by name
 * @returns the worktree if found, undefined otherwise
 */
export function getWorktree(name: string): WorkTree | undefined {
  const worktrees = loadWorktrees();
  return worktrees.find(w => w.name === name);
}