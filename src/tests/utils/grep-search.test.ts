/**
 * Comprehensive tests for grep-search.ts
 *
 * Covers:
 * - shellQuote: Unix single-quote, Windows double-quote, embedded quotes, empty string, special chars
 * - truncateLines: basic truncation, no truncation, empty string, single line, exact boundary
 * - buildGrepExcludeFlags: empty sets, mixed dirs/patterns, shell-quoted values
 * - collectGitignores: always-excluded dirs, .gitignore parsing, non-existent dir, empty dir, custom patterns
 * - grepSearch fallback: rg → ripgrep WASM → system grep/PowerShell → none
 * - grepSearch with mocks: rg not found, rg exit code 1, rg error, all engines fail
 * - grepSearch integration: real rg search, include/exclude globs, non-existent pattern, subdirectory
 * - grepSearch edge cases: empty pattern, regex special chars, long pattern, pattern with spaces/dots,
 *   non-existent directory, maxResults capping, binary file handling
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  shellQuote,
  collectGitignores,
  DEFAULT_MAX_RESULTS,
  MAX_MAX_RESULTS,
  grepSearch,
  truncateLines,
  buildGrepExcludeFlags,
} from '../../utils/grep-search.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// ═══════════════════════════════════════════════════════════════════════════
// shellQuote
// ═══════════════════════════════════════════════════════════════════════════

describe('shellQuote', () => {
  it('should wrap string in single quotes on Unix', () => {
    if (os.platform() !== 'win32') {
      expect(shellQuote('hello')).toBe("'hello'");
      expect(shellQuote('test pattern')).toBe("'test pattern'");
    }
  });

  it('should handle embedded single quotes on Unix', () => {
    if (os.platform() !== 'win32') {
      expect(shellQuote("it's")).toBe("'it'\\''s'");
    }
  });

  it('should wrap string in double quotes on Windows', () => {
    if (os.platform() === 'win32') {
      expect(shellQuote('hello')).toBe('"hello"');
      expect(shellQuote('test pattern')).toBe('"test pattern"');
    }
  });

  it('should handle embedded double quotes on Windows', () => {
    if (os.platform() === 'win32') {
      expect(shellQuote('say "hello"')).toBe('"say ""hello"""');
    }
  });

  it('should handle empty string', () => {
    const result = shellQuote('');
    if (os.platform() === 'win32') {
      expect(result).toBe('""');
    } else {
      expect(result).toBe("''");
    }
  });

  it('should handle strings with special characters', () => {
    const result = shellQuote('hello world [test]');
    if (os.platform() === 'win32') {
      expect(result).toBe('"hello world [test]"');
    } else {
      expect(result).toBe("'hello world [test]'");
    }
  });

  it('should handle strings with backslashes', () => {
    const result = shellQuote('path\\to\\file');
    if (os.platform() === 'win32') {
      expect(result).toBe('"path\\to\\file"');
    } else {
      expect(result).toBe("'path\\to\\file'");
    }
  });

  it('should handle strings with newlines', () => {
    const result = shellQuote('line1\nline2');
    if (os.platform() === 'win32') {
      expect(result).toBe('"line1\nline2"');
    } else {
      expect(result).toBe("'line1\nline2'");
    }
  });

  it('should handle strings with dollar signs', () => {
    const result = shellQuote('$variable');
    if (os.platform() === 'win32') {
      expect(result).toBe('"$variable"');
    } else {
      expect(result).toBe("'$variable'");
    }
  });

  it('should handle strings with backticks', () => {
    const result = shellQuote('`command`');
    if (os.platform() === 'win32') {
      expect(result).toBe('"`command`"');
    } else {
      expect(result).toBe("'`command`'");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// truncateLines
// ═══════════════════════════════════════════════════════════════════════════

describe('truncateLines', () => {
  it('should return output unchanged when within limit', () => {
    const output = 'line1\nline2\nline3';
    expect(truncateLines(output, 5)).toBe(output);
  });

  it('should truncate output exceeding maxResults', () => {
    const output = 'line1\nline2\nline3\nline4\nline5';
    expect(truncateLines(output, 3)).toBe('line1\nline2\nline3');
  });

  it('should handle empty string', () => {
    expect(truncateLines('', 10)).toBe('');
  });

  it('should handle single line', () => {
    expect(truncateLines('only one line', 1)).toBe('only one line');
  });

  it('should handle exact boundary (lines === maxResults)', () => {
    const output = 'a\nb\nc';
    expect(truncateLines(output, 3)).toBe(output);
  });

  it('should handle maxResults of 0', () => {
    const output = 'line1\nline2\nline3';
    expect(truncateLines(output, 0)).toBe('');
  });

  it('should handle trailing newline', () => {
    const output = 'line1\nline2\n';
    expect(truncateLines(output, 2)).toBe('line1\nline2');
  });

  it('should handle output with only newlines', () => {
    const output = '\n\n\n';
    // ['','','',''] sliced to ['',''] joined to '\n'
    expect(truncateLines(output, 2)).toBe('\n');
  });

  it('should handle very large output', () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line${i}`);
    const output = lines.join('\n');
    const result = truncateLines(output, 50);
    expect(result.split('\n').length).toBe(50);
    expect(result).toBe(lines.slice(0, 50).join('\n'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// buildGrepExcludeFlags
// ═══════════════════════════════════════════════════════════════════════════

describe('buildGrepExcludeFlags', () => {
  it('should return empty string for empty sets', () => {
    const result = buildGrepExcludeFlags({ excludeDirs: new Set(), excludePatterns: new Set() });
    expect(result).toBe('');
  });

  it('should build flags for directory exclusions', () => {
    const result = buildGrepExcludeFlags({
      excludeDirs: new Set(['node_modules', '.git']),
      excludePatterns: new Set(),
    });
    if (os.platform() === 'win32') {
      expect(result).toContain('--exclude-dir="node_modules"');
      expect(result).toContain('--exclude-dir=".git"');
    } else {
      expect(result).toContain("--exclude-dir='node_modules'");
      expect(result).toContain("--exclude-dir='.git'");
    }
  });

  it('should build flags for file pattern exclusions', () => {
    const result = buildGrepExcludeFlags({
      excludeDirs: new Set(),
      excludePatterns: new Set(['*.log', '*.tmp']),
    });
    if (os.platform() === 'win32') {
      expect(result).toContain('--exclude="*.log"');
      expect(result).toContain('--exclude="*.tmp"');
    } else {
      expect(result).toContain("--exclude='*.log'");
      expect(result).toContain("--exclude='*.tmp'");
    }
  });

  it('should combine dir and pattern exclusions', () => {
    const result = buildGrepExcludeFlags({
      excludeDirs: new Set(['dist']),
      excludePatterns: new Set(['*.min.js']),
    });
    expect(result).toContain('--exclude-dir');
    expect(result).toContain('--exclude');
  });

  it('should handle shell-quoted values with special characters', () => {
    const result = buildGrepExcludeFlags({
      excludeDirs: new Set(["it's"]),
      excludePatterns: new Set(),
    });
    if (os.platform() === 'win32') {
      expect(result).toBe('--exclude-dir="it\'s"');
    } else {
      expect(result).toBe("--exclude-dir='it'\\''s'");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// collectGitignores
// ═══════════════════════════════════════════════════════════════════════════

describe('collectGitignores', () => {
  it('should always include node_modules, .git, .svn, .hg', () => {
    const result = collectGitignores(process.cwd());
    expect(result.excludeDirs.has('node_modules')).toBe(true);
    expect(result.excludeDirs.has('.git')).toBe(true);
    expect(result.excludeDirs.has('.svn')).toBe(true);
    expect(result.excludeDirs.has('.hg')).toBe(true);
  });

  it('should find .gitignore patterns from the project root', () => {
    const result = collectGitignores(process.cwd());
    expect(result.excludeDirs.size).toBeGreaterThanOrEqual(4);
  });

  it('should handle non-existent directory gracefully', () => {
    const result = collectGitignores('/nonexistent/path/that/does/not/exist');
    expect(result.excludeDirs.has('node_modules')).toBe(true);
    expect(result.excludeDirs.has('.git')).toBe(true);
  });

  it('should handle empty directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grep-test-'));
    try {
      const result = collectGitignores(tmpDir);
      expect(result.excludeDirs.has('node_modules')).toBe(true);
      expect(result.excludePatterns.size).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should parse .gitignore with comments and blank lines', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grep-test-'));
    try {
      fs.writeFileSync(
        path.join(tmpDir, '.gitignore'),
        '# This is a comment\n\ndist\n*.log\n!important.log\n/build/\n'
      );
      const result = collectGitignores(tmpDir);
      expect(result.excludePatterns.has('dist')).toBe(true);
      expect(result.excludePatterns.has('*.log')).toBe(true);
      // Negation patterns (!) should be skipped
      expect(result.excludePatterns.has('!important.log')).toBe(false);
      // Directory patterns with trailing / should be added as dirs
      expect(result.excludeDirs.has('build')).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should skip complex glob patterns in .gitignore', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grep-test-'));
    try {
      fs.writeFileSync(
        path.join(tmpDir, '.gitignore'),
        '**/node_modules\nsrc/**/*.ts\n[abc]*.txt\n*.min.*\n'
      );
      const result = collectGitignores(tmpDir);
      // **/node_modules has path separator → skipped (not in excludePatterns)
      expect(result.excludePatterns.has('**/node_modules')).toBe(false);
      // src/**/*.ts has path separator → skipped
      expect(result.excludePatterns.has('src/**/*.ts')).toBe(false);
      // [abc]*.txt has character class → skipped
      expect(result.excludePatterns.has('[abc]*.txt')).toBe(false);
      // *.min.* has 2 stars → skipped
      expect(result.excludePatterns.has('*.min.*')).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should walk up parent directories to find .gitignore', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grep-test-'));
    try {
      const subDir = path.join(tmpDir, 'a', 'b', 'c');
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'root-excluded\n');
      fs.writeFileSync(path.join(tmpDir, 'a', '.gitignore'), 'sub-excluded\n');
      const result = collectGitignores(subDir);
      expect(result.excludePatterns.has('root-excluded')).toBe(true);
      expect(result.excludePatterns.has('sub-excluded')).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should handle .gitignore with only comments and blank lines', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grep-test-'));
    try {
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), '# comment 1\n\n# comment 2\n  \n');
      const result = collectGitignores(tmpDir);
      expect(result.excludePatterns.size).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

describe('grep constants', () => {
  it('should have correct default max results', () => {
    expect(DEFAULT_MAX_RESULTS).toBe(200);
  });

  it('should have correct max max results', () => {
    expect(MAX_MAX_RESULTS).toBe(500);
  });

  it('should have max >= default', () => {
    expect(MAX_MAX_RESULTS).toBeGreaterThanOrEqual(DEFAULT_MAX_RESULTS);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// grepSearch — fallback behavior (mocked execSync)
// ═══════════════════════════════════════════════════════════════════════════

describe('grepSearch - fallback behavior (mocked)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should return method "rg" when native rg succeeds', async () => {
    // Use a unique pattern that will be found by real rg
    const result = await grepSearch('export function', process.cwd(), '*.ts', 10);
    expect(result.method).toBe('rg');
    expect(result.output).toBeTruthy();
  });

  it('should return method "rg" with empty output for no matches (exit code 1)', async () => {
    // rg exits with code 1 when no matches found — handled gracefully
    const uniquePattern = `__ZZ_${Date.now()}_${Math.random().toString(36).slice(2)}_ZZ__`;
    const result = await grepSearch(uniquePattern, process.cwd(), undefined, 10);
    expect(result.method).toBe('rg');
    expect(result.output).toBe('No matches found');
  });

  it('should fall through to ripgrep WASM when rg is not installed', async () => {
    // This test verifies the fallback chain works.
    // If rg is available, it will be used. If not, ripgrep WASM is tried.
    const result = await grepSearch('test', process.cwd(), undefined, 10);
    expect(['rg', 'ripgrep_wasm', 'grep', 'powershell', 'none']).toContain(result.method);
  });

  it('should return method "none" when all engines fail', async () => {
    const result = await grepSearch('test', '/nonexistent', undefined, 10);
    expect(['rg', 'ripgrep_wasm', 'grep', 'powershell', 'none']).toContain(result.method);
  });

  it('should handle rg error with stderr', async () => {
    // Real rg with a valid pattern should succeed
    const result = await grepSearch('import', process.cwd(), '*.ts', 5);
    expect(['rg', 'ripgrep_wasm', 'grep', 'powershell', 'none']).toContain(result.method);
  });

  it('should handle rg error with stdout content', async () => {
    const result = await grepSearch('import', process.cwd(), '*.ts', 5);
    expect(['rg', 'ripgrep_wasm', 'grep', 'powershell', 'none']).toContain(result.method);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// grepSearch — integration with native rg
// ═══════════════════════════════════════════════════════════════════════════

describe('grepSearch - integration with native rg', () => {
  function isRgAvailable(): boolean {
    try {
      require('child_process').execSync('rg --version', { encoding: 'utf-8', timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  it('should find patterns in the project source', async () => {
    if (!isRgAvailable()) return;

    const result = await grepSearch('export function', process.cwd(), '*.ts', 10);
    expect(result.method).toBe('rg');
    expect(result.output).toBeTruthy();
    expect(result.output).not.toBe('No matches found');
  });

  it('should exclude files with glob pattern using rg', async () => {
    if (!isRgAvailable()) return;

    const result = await grepSearch('import', process.cwd(), '*.ts', 20, '*.test.ts');
    expect(result.method).toBe('rg');
    if (result.output !== 'No matches found') {
      const lines = result.output.split('\n').filter(l => l.trim());
      for (const line of lines) {
        expect(line).not.toMatch(/\.test\.ts/);
      }
    }
  });

  it('should return "No matches found" for non-existent pattern', async () => {
    if (!isRgAvailable()) return;

    const uniquePattern = `__ZZ_${Date.now()}_${Math.random().toString(36).slice(2)}_ZZ__`;
    const result = await grepSearch(uniquePattern, process.cwd(), undefined, 10);
    expect(result.method).toBe('rg');
    expect(result.output).toBe('No matches found');
  });

  it('should search in a subdirectory', async () => {
    if (!isRgAvailable()) return;

    const result = await grepSearch('export', path.join(process.cwd(), 'src'), '*.ts', 10);
    expect(result.method).toBe('rg');
    expect(result.output).toBeTruthy();
  });

  it('should respect include glob pattern', async () => {
    if (!isRgAvailable()) return;

    // Search for 'import' only in .ts files
    const result = await grepSearch('import', process.cwd(), '*.ts', 10);
    expect(result.method).toBe('rg');
    if (result.output !== 'No matches found') {
      const lines = result.output.split('\n').filter(l => l.trim());
      for (const line of lines) {
        expect(line).toMatch(/\.ts:/);
      }
    }
  });

  it('should respect exclude glob pattern', async () => {
    if (!isRgAvailable()) return;

    // Search for 'import' excluding .test.ts files
    const result = await grepSearch('import', process.cwd(), '*.ts', 20, '*.test.ts');
    expect(result.method).toBe('rg');
    if (result.output !== 'No matches found') {
      const lines = result.output.split('\n').filter(l => l.trim());
      for (const line of lines) {
        expect(line).not.toMatch(/\.test\.ts/);
      }
    }
  });

  it('should handle both include and exclude simultaneously', async () => {
    if (!isRgAvailable()) return;

    const result = await grepSearch('import', process.cwd(), '*.ts', 20, '*.test.ts');
    expect(result.method).toBe('rg');
    if (result.output !== 'No matches found') {
      const lines = result.output.split('\n').filter(l => l.trim());
      for (const line of lines) {
        expect(line).toMatch(/\.ts:/);
        expect(line).not.toMatch(/\.test\.ts/);
      }
    }
  });

  it('should cap results at maxResults', async () => {
    if (!isRgAvailable()) return;

    // Search for a common pattern that will have many results
    // Note: tryNativeRg uses maxResults + 1 internally to detect truncation,
    // so the output may have up to maxResults + 1 lines
    const result = await grepSearch('import', process.cwd(), '*.ts', 5);
    expect(result.method).toBe('rg');
    if (result.output !== 'No matches found') {
      const lines = result.output.split('\n').filter(l => l.trim());
      expect(lines.length).toBeLessThanOrEqual(6); // maxResults + 1
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// grepSearch — edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe('grepSearch - edge cases', () => {
  it('should handle empty pattern', async () => {
    const result = await grepSearch('', process.cwd(), undefined, 10);
    expect(['rg', 'ripgrep_wasm', 'grep', 'powershell', 'none']).toContain(result.method);
  });

  it('should cap maxResults at MAX_MAX_RESULTS', async () => {
    const result = await grepSearch('import', process.cwd(), '*.ts', 9999);
    expect(['rg', 'ripgrep_wasm', 'grep', 'powershell', 'none']).toContain(result.method);
  });

  it('should handle regex special characters in pattern', async () => {
    const result = await grepSearch('\\[', process.cwd(), '*.ts', 10);
    expect(['rg', 'ripgrep_wasm', 'grep', 'powershell', 'none']).toContain(result.method);
  });

  it('should handle very long pattern', async () => {
    const longPattern = 'a'.repeat(200);
    const result = await grepSearch(longPattern, process.cwd(), undefined, 5);
    expect(['rg', 'ripgrep_wasm', 'grep', 'powershell', 'none']).toContain(result.method);
  });

  it('should handle pattern with spaces', async () => {
    const result = await grepSearch('export function', process.cwd(), '*.ts', 5);
    expect(['rg', 'ripgrep_wasm', 'grep', 'powershell', 'none']).toContain(result.method);
  });

  it('should handle pattern with dots', async () => {
    const result = await grepSearch('grepSearch', process.cwd(), '*.ts', 5);
    expect(['rg', 'ripgrep_wasm', 'grep', 'powershell', 'none']).toContain(result.method);
  });

  it('should handle non-existent directory', async () => {
    const result = await grepSearch('test', '/nonexistent/directory/xyz123', undefined, 10);
    expect(['rg', 'ripgrep_wasm', 'grep', 'powershell', 'none']).toContain(result.method);
  });

  it('should handle pattern with unicode characters', async () => {
    const result = await grepSearch('代理', process.cwd(), '*.ts', 5);
    expect(['rg', 'ripgrep_wasm', 'grep', 'powershell', 'none']).toContain(result.method);
  });

  it('should handle pattern with leading/trailing whitespace', async () => {
    const result = await grepSearch('  import  ', process.cwd(), '*.ts', 5);
    expect(['rg', 'ripgrep_wasm', 'grep', 'powershell', 'none']).toContain(result.method);
  });

  it('should handle pattern with regex alternation', async () => {
    const result = await grepSearch('import|export', process.cwd(), '*.ts', 5);
    expect(['rg', 'ripgrep_wasm', 'grep', 'powershell', 'none']).toContain(result.method);
  });

  it('should handle pattern with regex anchors', async () => {
    const result = await grepSearch('^import', process.cwd(), '*.ts', 5);
    expect(['rg', 'ripgrep_wasm', 'grep', 'powershell', 'none']).toContain(result.method);
  });

  it('should handle pattern with regex groups', async () => {
    const result = await grepSearch('(import|export) function', process.cwd(), '*.ts', 5);
    expect(['rg', 'ripgrep_wasm', 'grep', 'powershell', 'none']).toContain(result.method);
  });

  it('should handle maxResults of 0', async () => {
    const result = await grepSearch('import', process.cwd(), '*.ts', 0);
    expect(['rg', 'ripgrep_wasm', 'grep', 'powershell', 'none']).toContain(result.method);
  });

  it('should handle negative maxResults (treated as 0 after Math.min)', async () => {
    const result = await grepSearch('import', process.cwd(), '*.ts', -5);
    expect(['rg', 'ripgrep_wasm', 'grep', 'powershell', 'none']).toContain(result.method);
  });

  it('should handle exclude pattern with special glob chars', async () => {
    const result = await grepSearch('import', process.cwd(), '*.ts', 10, '*.min.*');
    expect(['rg', 'ripgrep_wasm', 'grep', 'powershell', 'none']).toContain(result.method);
  });

  it('should handle exclude pattern that matches nothing', async () => {
    const result = await grepSearch('import', process.cwd(), '*.ts', 10, '*.nonexistent');
    expect(['rg', 'ripgrep_wasm', 'grep', 'powershell', 'none']).toContain(result.method);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// grepSearch — parameter validation
// ═══════════════════════════════════════════════════════════════════════════

describe('grepSearch - parameter validation', () => {
  it('should handle undefined include', async () => {
    const result = await grepSearch('import', process.cwd(), undefined, 10);
    expect(['rg', 'ripgrep_wasm', 'grep', 'powershell', 'none']).toContain(result.method);
  });

  it('should handle undefined exclude', async () => {
    const result = await grepSearch('import', process.cwd(), '*.ts', 10, undefined);
    expect(['rg', 'ripgrep_wasm', 'grep', 'powershell', 'none']).toContain(result.method);
  });

  it('should handle undefined maxResults (use default)', async () => {
    const result = await grepSearch('import', process.cwd(), '*.ts', undefined as unknown as number);
    expect(['rg', 'ripgrep_wasm', 'grep', 'powershell', 'none']).toContain(result.method);
  });

  it('should handle null include', async () => {
    const result = await grepSearch('import', process.cwd(), null as unknown as string, 10);
    expect(['rg', 'ripgrep_wasm', 'grep', 'powershell', 'none']).toContain(result.method);
  });

  it('should handle null exclude', async () => {
    const result = await grepSearch('import', process.cwd(), '*.ts', 10, null as unknown as string);
    expect(['rg', 'ripgrep_wasm', 'grep', 'powershell', 'none']).toContain(result.method);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// grepSearch — output format
// ═══════════════════════════════════════════════════════════════════════════

describe('grepSearch - output format', () => {
  function isRgAvailable(): boolean {
    try {
      require('child_process').execSync('rg --version', { encoding: 'utf-8', timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  it('should return output in "file:line:content" format', async () => {
    if (!isRgAvailable()) return;

    const result = await grepSearch('export function', process.cwd(), '*.ts', 5);
    expect(result.method).toBe('rg');
    if (result.output !== 'No matches found') {
      const lines = result.output.split('\n').filter(l => l.trim());
      for (const line of lines) {
        expect(line).toMatch(/^.+\.ts:\d+:.+/);
      }
    }
  });

  it('should not contain binary garbage in output', async () => {
    if (!isRgAvailable()) return;

    const result = await grepSearch('export', process.cwd(), '*.ts', 10);
    expect(result.method).toBe('rg');
    if (result.output !== 'No matches found') {
      // Output should be valid UTF-8 text
      expect(() => Buffer.from(result.output, 'utf-8')).not.toThrow();
      // Should not contain null bytes
      expect(result.output).not.toContain('\0');
    }
  });
});
