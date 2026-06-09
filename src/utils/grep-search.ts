/**
 * grep-search.ts - Core grep/search utility with hierarchical fallback
 *
 * Zero agent-system dependencies — usable by both the grep tool
 * and the explorer agent without circular imports.
 *
 * Fallback chain:
 *   1. Native ripgrep (rg) — fastest, respects .gitignore by default
 *   2. System grep (Unix) or findstr (Windows) — platform native
 *   3. npm ripgrep WASM package — cross-platform, zero native deps
 *   4. Error directing LLM to use bash (with node_modules exclusion warning)
 */

import { execSync } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

export const DEFAULT_MAX_RESULTS = 200;
export const MAX_MAX_RESULTS = 500;

const IS_WINDOWS = os.platform() === 'win32';

// Common directories that should always be excluded from search
const ALWAYS_EXCLUDE_DIRS = new Set(['node_modules', '.git', '.svn', '.hg']);

/**
 * Result of parsing .gitignore files along a directory path.
 */
interface GitignoreResult {
  /** Directory names to exclude (e.g., "node_modules", "dist") */
  excludeDirs: Set<string>;
  /** File patterns to exclude (e.g., "*.log", "*.min.js") */
  excludePatterns: Set<string>;
}

/**
 * Escape a string for use in a shell command as a pattern argument.
 * Uses single-quote escaping on Unix, double-quote on Windows.
 */
function shellQuote(s: string): string {
  if (IS_WINDOWS) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Parse a single .gitignore file and merge its patterns into the result.
 * Handles: comments (#), blank lines, negation (!), directory indicators (trailing /).
 */
function parseGitignoreFile(
  filePath: string,
  result: GitignoreResult
): void {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return; // file disappeared or unreadable
  }

  const lines = content.split('\n');
  for (let line of lines) {
    // Trim whitespace and skip comments / blanks
    line = line.trim();
    if (!line || line.startsWith('#')) continue;

    // Skip negation patterns (! — they re-include, hard to handle in shell exclusion)
    if (line.startsWith('!')) continue;

    // Remove leading slash (root-relative indicator)
    if (line.startsWith('/')) line = line.slice(1);

    // Remove trailing slash (directory indicator)
    if (line.endsWith('/')) {
      const dirName = line.slice(0, -1);
      // Only simple directory names (no wildcards, no path separators)
      if (dirName && !dirName.includes('*') && !dirName.includes('?') && !dirName.includes('/') && !dirName.includes('[')) {
        result.excludeDirs.add(dirName);
      }
      continue;
    }

    // Skip patterns with path separators (too complex for simple --exclude)
    if (line.includes('/')) continue;

    // Skip complex glob patterns that grep --exclude can't handle
    // Only accept simple patterns like *.ext, ?.ext
    if (line.includes('[') || line.includes(']')) continue;

    // Count wildcard complexity — only allow simple patterns
    const starCount = (line.match(/\*/g) || []).length;
    if (starCount > 1) continue;

    result.excludePatterns.add(line);
  }
}

/**
 * Walk up from the search directory to find all .gitignore files.
 * Stops at the filesystem root or when no parent directory exists.
 */
export function collectGitignores(searchDir: string): GitignoreResult {
  const result: GitignoreResult = {
    excludeDirs: new Set(),
    excludePatterns: new Set(),
  };

  // Always exclude common VCS and dependency directories
  for (const d of ALWAYS_EXCLUDE_DIRS) {
    result.excludeDirs.add(d);
  }

  let current = path.resolve(searchDir);
  const root = path.parse(current).root;

  while (current !== root && current !== path.dirname(current)) {
    const gitignorePath = path.join(current, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      parseGitignoreFile(gitignorePath, result);
    }
    current = path.dirname(current);
  }

  // Also check root
  const rootGitignore = path.join(root, '.gitignore');
  if (fs.existsSync(rootGitignore)) {
    parseGitignoreFile(rootGitignore, result);
  }

  return result;
}

/**
 * Build --exclude-dir and --exclude flags for grep from gitignore data.
 */
function buildGrepExcludeFlags(gi: GitignoreResult): string {
  const parts: string[] = [];
  for (const d of gi.excludeDirs) {
    parts.push(`--exclude-dir=${shellQuote(d)}`);
  }
  for (const p of gi.excludePatterns) {
    parts.push(`--exclude=${shellQuote(p)}`);
  }
  return parts.join(' ');
}

/**
 * Attempt to run native ripgrep (cross-platform binary).
 * Returns { stdout, stderr, code } or null if rg is not available.
 */
function tryNativeRg(
  pattern: string,
  dir: string,
  include: string | undefined,
  maxResults: number
): { stdout: string; stderr: string; code: number } | null {
  try {
    const includeFlag = include ? `--glob ${shellQuote(include)}` : '';
    const headCmd = IS_WINDOWS
      ? `rg -n --no-heading --color never ${includeFlag} ${shellQuote(pattern)} ${shellQuote(dir)} 2>&1`
      : `rg -n --no-heading --color never ${includeFlag} ${shellQuote(pattern)} ${shellQuote(dir)} 2>&1 | head -n ${maxResults}`;
    const stdout = execSync(headCmd, {
      encoding: 'utf-8',
      timeout: 15000,
      maxBuffer: 500 * 1024,
      shell: IS_WINDOWS ? 'cmd.exe' : '/bin/bash',
    });
    const lines = stdout.split('\n');
    const truncated = lines.slice(0, maxResults + 1);
    return { stdout: truncated.join('\n'), stderr: '', code: 0 };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    if (e.code === 'ENOENT') {
      return null;
    }
    const stdout = e.stdout ? String(e.stdout) : '';
    const stderr = e.stderr ? String(e.stderr) : '';
    return { stdout, stderr, code: e.status ?? 2 };
  }
}

/**
 * Attempt to run system grep (Unix) or findstr (Windows).
 */
function trySystemGrep(
  pattern: string,
  dir: string,
  include: string | undefined,
  maxResults: number
): { stdout: string; stderr: string; code: number } | null {
  if (IS_WINDOWS) {
    return tryFindstr(pattern, dir, include, maxResults);
  }
  return tryUnixGrep(pattern, dir, include, maxResults);
}

/**
 * Unix: grep -rn with file include and .gitignore-aware exclusions.
 */
function tryUnixGrep(
  pattern: string,
  dir: string,
  include: string | undefined,
  maxResults: number
): { stdout: string; stderr: string; code: number } | null {
  try {
    const gi = collectGitignores(dir);
    const excludeFlags = buildGrepExcludeFlags(gi);
    const includeArg = include
      ? `--include=${shellQuote(include)}`
      : '';
    const cmd = `grep -rn ${excludeFlags} ${includeArg} -- ${shellQuote(pattern)} ${shellQuote(dir)} 2>/dev/null | head -n ${maxResults}`;
    const stdout = execSync(cmd, {
      encoding: 'utf-8',
      timeout: 15000,
      maxBuffer: 500 * 1024,
    });
    return { stdout, stderr: '', code: 0 };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    if (e.code === 'ENOENT') {
      return null;
    }
    const stdout = e.stdout ? String(e.stdout) : '';
    const stderr = e.stderr ? String(e.stderr) : '';
    return { stdout, stderr, code: e.status ?? 1 };
  }
}

/**
 * Windows: findstr with recursive flag and .gitignore-aware exclusions.
 */
function tryFindstr(
  pattern: string,
  dir: string,
  include: string | undefined,
  maxResults: number
): { stdout: string; stderr: string; code: number } | null {
  try {
    const gi = collectGitignores(dir);
    const filePattern = include || '*.*';
    let cmd = `cmd /c "dir /s /b ${shellQuote(path.join(dir, filePattern))} 2>nul`;
    for (const excludeDir of gi.excludeDirs) {
      cmd += ` | findstr /v /i /c:"\\\\${excludeDir}\\\\" /c:"/${excludeDir}/"`;
    }
    cmd += ` | findstr /n /i ${shellQuote(pattern)}"`;
    const stdout = execSync(cmd, {
      encoding: 'utf-8',
      timeout: 15000,
      maxBuffer: 500 * 1024,
    });
    const lines = stdout.split('\n').filter(Boolean);
    const truncated = lines.slice(0, maxResults);
    return { stdout: truncated.join('\n'), stderr: '', code: 0 };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    const stdout = e.stdout ? String(e.stdout) : '';
    const stderr = e.stderr ? String(e.stderr) : '';
    if (e.code === 'ENOENT' || e.status === 255) {
      return null;
    }
    return { stdout, stderr, code: e.status ?? 1 };
  }
}

/**
 * Attempt to use the npm ripgrep WASM package.
 * Builds explicit --glob exclusions from collected gitignores
 * since WASM context may not auto-detect .gitignore files.
 */
async function tryNpmRipgrep(
  pattern: string,
  dir: string,
  include: string | undefined,
  maxResults: number
): Promise<{ stdout: string; code: number } | null> {
  try {
    const rg = await import('ripgrep');
    const gi = collectGitignores(dir);
    const args: string[] = [
      '-n', '--no-heading', '--color', 'never',
      '--no-require-git',
    ];
    if (include) {
      args.push('--glob', include);
    }
    for (const d of gi.excludeDirs) {
      args.push('--glob', `!${d}/**`);
    }
    for (const p of gi.excludePatterns) {
      args.push('--glob', `!${p}`);
    }
    args.push(pattern, dir);

    const result = await rg.ripgrep(args, {
      buffer: true,
      preopens: { '.': dir },
      returnOnExit: true,
    }) as { stdout: string; stderr: string; code: number };

    const lines = result.stdout.split('\n').filter(Boolean);
    const truncated = lines.slice(0, maxResults);
    return { stdout: truncated.join('\n'), code: result.code };
  } catch {
    return null;
  }
}

/**
 * Core grep function with hierarchical fallback.
 *
 * @param pattern - Search pattern (regex compatible)
 * @param dir - Directory to search
 * @param include - Optional file glob pattern (e.g., "*.ts")
 * @param maxResults - Maximum results to return (default: 200, max: 500)
 * @returns Object with { output, method } where method indicates which engine was used
 */
export async function grepSearch(
  pattern: string,
  dir: string,
  include?: string,
  maxResults: number = DEFAULT_MAX_RESULTS
): Promise<{ output: string; method: 'rg' | 'grep' | 'findstr' | 'ripgrep_wasm' | 'none' }> {
  const cappedMax = Math.min(maxResults, MAX_MAX_RESULTS);

  // 1. Try native ripgrep
  const rgResult = tryNativeRg(pattern, dir, include, cappedMax);
  if (rgResult !== null) {
    const output = rgResult.stdout.trim();
    return { output: output || 'No matches found', method: 'rg' };
  }

  // 2. Try system grep / findstr
  const grepResult = trySystemGrep(pattern, dir, include, cappedMax);
  if (grepResult !== null) {
    const output = grepResult.stdout.trim();
    return { output: output || 'No matches found', method: IS_WINDOWS ? 'findstr' : 'grep' };
  }

  // 3. Try npm ripgrep WASM package
  const npmResult = await tryNpmRipgrep(pattern, dir, include, cappedMax);
  if (npmResult !== null) {
    const output = npmResult.stdout.trim();
    return { output: output || 'No matches found', method: 'ripgrep_wasm' };
  }

  // 4. All attempts failed
  return { output: '', method: 'none' };
}
