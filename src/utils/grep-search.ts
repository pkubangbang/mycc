/**
 * grep-search.ts - Core grep/search utility with hierarchical fallback
 *
 * Zero agent-system dependencies — usable by both the grep tool
 * and the explorer agent without circular imports.
 *
 * Fallback chain:
 *   1. Native ripgrep (rg) — fastest, respects .gitignore by default
 *   2. npm ripgrep WASM package — cross-platform, zero native deps
 *   3. System grep (Unix) or PowerShell Select-String (Windows) — platform native
 *   4. Error directing LLM to use bash (with node_modules exclusion warning)
 *
 * On Windows, ripgrep WASM is tried before PowerShell Select-String because
 * Get-ChildItem -Recurse is very slow on large directory trees.
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
export interface GitignoreResult {
  /** Directory names to exclude (e.g., "node_modules", "dist") */
  excludeDirs: Set<string>;
  /** File patterns to exclude (e.g., "*.log", "*.min.js") */
  excludePatterns: Set<string>;
}

/**
 * Escape a string for use in a shell command as a pattern argument.
 * Uses single-quote escaping on Unix, double-quote on Windows.
 */
export function shellQuote(s: string): string {
  if (IS_WINDOWS) {
    // PowerShell: escape double quotes by doubling them
    return `"${s.replace(/"/g, '""')}"`;
  }
  // Unix: single quotes with embedded single-quote handling
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
export function buildGrepExcludeFlags(gi: GitignoreResult): string {
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
 * Truncate output to at most maxResults lines.
 * Works cross-platform (no dependency on `head` command).
 */
export function truncateLines(output: string, maxResults: number): string {
  const lines = output.split('\n');
  if (lines.length <= maxResults) return output;
  return lines.slice(0, maxResults).join('\n');
}

/**
 * Attempt to run native ripgrep (cross-platform binary).
 * Uses Node.js to truncate output instead of shell piping to `head`,
 * which is not available on Windows.
 */
function tryNativeRg(
  pattern: string,
  dir: string,
  include: string | undefined,
  exclude: string | undefined,
  maxResults: number
): { stdout: string; stderr: string; code: number } | null {
  try {
    const includeFlag = include ? `--glob ${shellQuote(include)}` : '';
    const excludeFlag = exclude ? `--glob ${shellQuote(`!${exclude}`)}` : '';
    // Build the command WITHOUT shell piping — use Node.js truncation instead
    const cmd = `rg -n --no-heading --color never ${includeFlag} ${excludeFlag} ${shellQuote(pattern)} ${shellQuote(dir)} 2>&1`;
    const stdout = execSync(cmd, {
      encoding: 'utf-8',
      timeout: 15000,
      maxBuffer: 500 * 1024,
      // Use default shell (no /bin/bash hardcoding) for cross-platform compatibility
    });
    const truncated = truncateLines(stdout, maxResults + 1);
    return { stdout: truncated, stderr: '', code: 0 };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    if (e.code === 'ENOENT') {
      return null; // rg not installed
    }
    const stdout = e.stdout ? String(e.stdout) : '';
    const stderr = e.stderr ? String(e.stderr) : '';
    // rg exits with code 1 when no matches found — that's not a failure
    if (e.status === 1 && !stderr) {
      return { stdout: '', stderr: '', code: 0 };
    }
    return { stdout, stderr, code: e.status ?? 2 };
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
  exclude: string | undefined,
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
    if (exclude) {
      args.push('--glob', `!${exclude}`);
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
 * Attempt to run system grep (Unix) or PowerShell Select-String (Windows).
 */
function trySystemGrep(
  pattern: string,
  dir: string,
  include: string | undefined,
  exclude: string | undefined,
  maxResults: number
): { stdout: string; stderr: string; code: number } | null {
  if (IS_WINDOWS) {
    return tryPowerShellSelectString(pattern, dir, include, exclude, maxResults);
  }
  return tryUnixGrep(pattern, dir, include, exclude, maxResults);
}

/**
 * Unix: grep -rn with file include and .gitignore-aware exclusions.
 * Uses Node.js truncation instead of shell piping to `head`.
 */
function tryUnixGrep(
  pattern: string,
  dir: string,
  include: string | undefined,
  exclude: string | undefined,
  maxResults: number
): { stdout: string; stderr: string; code: number } | null {
  try {
    const gi = collectGitignores(dir);
    const excludeFlags = buildGrepExcludeFlags(gi);
    const includeArg = include
      ? `--include=${shellQuote(include)}`
      : '';
    const excludeArg = exclude
      ? `--exclude=${shellQuote(exclude)}`
      : '';
    const cmd = `grep -rn ${excludeFlags} ${includeArg} ${excludeArg} -- ${shellQuote(pattern)} ${shellQuote(dir)} 2>/dev/null`;
    const stdout = execSync(cmd, {
      encoding: 'utf-8',
      timeout: 15000,
      maxBuffer: 500 * 1024,
      // Use default shell — no /bin/bash hardcoding
    });
    const truncated = truncateLines(stdout, maxResults);
    return { stdout: truncated, stderr: '', code: 0 };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    if (e.code === 'ENOENT') {
      return null;
    }
    const stdout = e.stdout ? String(e.stdout) : '';
    const stderr = e.stderr ? String(e.stderr) : '';
    // grep exits with code 1 when no matches found
    if (e.status === 1 && !stderr) {
      return { stdout: '', stderr: '', code: 0 };
    }
    return { stdout, stderr, code: e.status ?? 1 };
  }
}

/**
 * Windows: PowerShell Select-String with .gitignore-aware exclusions.
 * Replaces findstr (which has poor Unicode support) with PowerShell's
 * native Select-String cmdlet that operates on .NET strings (Unicode-aware).
 *
 * Uses -EncodedCommand with UTF-16LE base64 encoding to avoid shell quoting
 * issues, matching the pattern used by agent-io.ts.
 */
function tryPowerShellSelectString(
  pattern: string,
  dir: string,
  include: string | undefined,
  exclude: string | undefined,
  maxResults: number
): { stdout: string; stderr: string; code: number } | null {
  try {
    const gi = collectGitignores(dir);

    // Build directory exclusion using -notlike (wildcard matching, not regex)
    // to avoid regex-escaping directory names. Match both \ and / path separators.
    let dirExclusions = '';
    for (const excludeDir of gi.excludeDirs) {
      dirExclusions += ` -and $_.FullName -notlike '*\\${excludeDir}\\*' -and $_.FullName -notlike '*/${excludeDir}/*'`;
    }

    // Build Get-ChildItem filter for file pattern
    const filterPart = include ? `-Filter '${include.replace(/'/g, "''")}'` : '';

    // Build file exclusion filter (e.g., exclude "*.min.js")
    const excludeFilterPart = exclude
      ? ` | Where-Object { $_.Name -notlike '${exclude.replace(/'/g, "''")}' }`
      : '';

    // Escape single quotes in pattern and dir for PowerShell single-quoted strings
    const psEscapedPattern = pattern.replace(/'/g, "''");
    const psEscapedDir = dir.replace(/'/g, "''");

    // PowerShell pipeline: recursive file listing → exclude dirs → Select-String → limit → format
    // Select-String uses regex matching by default (same as grep/rg)
    const psCmd =
      `Get-ChildItem -Path '${psEscapedDir}' -Recurse -File ${filterPart} -ErrorAction SilentlyContinue | ` +
      `Where-Object { $true ${dirExclusions} }${excludeFilterPart} | ` +
      `Select-String -Pattern '${psEscapedPattern}' | ` +
      `Select-Object -First ${maxResults} | ` +
      `ForEach-Object { "$($_.Path):$($_.LineNumber):$($_.Line)" }`;

    // Base64-encode as UTF-16LE for -EncodedCommand (matching agent-io.ts pattern)
    const fullCmd = `try { chcp 65001 > $null } catch {}; $OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${psCmd}`;
    const base64Cmd = Buffer.from(fullCmd, 'utf16le').toString('base64');

    const stdout = execSync(
      `powershell -NoProfile -NonInteractive -EncodedCommand ${base64Cmd}`,
      {
        encoding: 'utf-8',
        timeout: 30000, // PowerShell is slower, give it more time
        maxBuffer: 500 * 1024,
      }
    );

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
 * Core grep function with hierarchical fallback.
 *
 * Fallback order:
 *   1. Native ripgrep (rg) — fastest, respects .gitignore by default
 *   2. npm ripgrep WASM — cross-platform, tried early on Windows because
 *      PowerShell Get-ChildItem -Recurse is very slow on large directories
 *   3. System grep (Unix) or PowerShell Select-String (Windows)
 *   4. 'none' — all attempts failed
 *
 * @param pattern - Search pattern (regex compatible)
 * @param dir - Directory to search
 * @param include - Optional file glob pattern to include (e.g., "*.ts")
 * @param maxResults - Maximum results to return (default: 200, max: 500)
 * @param exclude - Optional file glob pattern to exclude (e.g., "*.min.js")
 * @returns Object with { output, method } where method indicates which engine was used
 */
export async function grepSearch(
  pattern: string,
  dir: string,
  include?: string,
  maxResults: number = DEFAULT_MAX_RESULTS,
  exclude?: string
): Promise<{ output: string; method: 'rg' | 'ripgrep_wasm' | 'grep' | 'powershell' | 'none' }> {
  const cappedMax = Math.min(maxResults, MAX_MAX_RESULTS);

  // 1. Try native ripgrep (fastest, respects .gitignore)
  const rgResult = tryNativeRg(pattern, dir, include, exclude, cappedMax);
  if (rgResult !== null) {
    const output = rgResult.stdout.trim();
    return { output: output || 'No matches found', method: 'rg' };
  }

  // 2. Try npm ripgrep WASM package
  //    On Windows, this is tried before system grep because PowerShell
  //    Get-ChildItem -Recurse is very slow on large directory trees.
  const npmResult = await tryNpmRipgrep(pattern, dir, include, exclude, cappedMax);
  if (npmResult !== null) {
    const output = npmResult.stdout.trim();
    return { output: output || 'No matches found', method: 'ripgrep_wasm' };
  }

  // 3. Try system grep / PowerShell
  const grepResult = trySystemGrep(pattern, dir, include, exclude, cappedMax);
  if (grepResult !== null) {
    const output = grepResult.stdout.trim();
    return { output: output || 'No matches found', method: IS_WINDOWS ? 'powershell' : 'grep' };
  }

  // 4. All attempts failed
  return { output: '', method: 'none' };
}
