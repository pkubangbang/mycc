/**
 * shell-detect.ts - Startup shell detection (single source of truth)
 *
 * Detected ONCE at startup and committed to — no runtime conditionals, no
 * smart per-call fallback. There are exactly four outcomes:
 *
 *   Platform  | Shell
 *   ----------|---------------------------
 *   Linux     | bash
 *   macOS     | zsh
 *   Windows   | PowerShell 5.1 (powershell)
 *   Windows   | PowerShell 7   (pwsh)
 *
 * On Windows, pwsh 7 is chosen when present, otherwise Windows PowerShell
 * 5.1 — both are legitimate first-class outcomes, not a degraded fallback.
 * The detected result is consumed by:
 *   - `agent-prompts.ts` — the system prompt is tailored to the ONE detected
 *     shell and hides guidance that does not apply (e.g. the 5.1 BOM/mojibake
 *     warnings are shown only when 5.1 is detected; pwsh 7's utf8NoBOM note is
 *     shown only when pwsh 7 is detected).
 *   - `agent-io.ts` exec() — spawns the detected shell (applying the 5.1
 *     Layer-2 patch only when the detected shell is 5.1).
 *
 * Detection is cheap (a few existsSync / PATH scans) and idempotent, so child
 * processes (teammates) re-detect on first use with the same result — no env
 * threading from Coordinator → Lead → child is needed.
 */

import { accessSync, constants, statSync } from 'fs';
import { join, delimiter } from 'path';

/** The four first-class shell outcomes mycc commits to at startup. */
export type ShellKind = 'bash' | 'zsh' | 'powershell5' | 'pwsh7';

/** Resolved shell for the current process. */
export interface ShellInfo {
  /** true on win32. */
  isWin: boolean;
  /** The detected OS, for the platform line of the system prompt. */
  platform: 'Linux' | 'macOS' | 'Windows';
  /** Which of the four shells was committed to. */
  shell: ShellKind;
  /** Absolute path to the shell executable (set for the Windows shells). */
  path?: string;
}

let cached: ShellInfo | null = null;

/**
 * Lightweight existence check that never throws on inaccessible paths.
 *
 * Uses accessSync (access(2)) rather than existsSync/statSync (stat(2)).
 * stat(2) returns ENOENT/EACCES on Microsoft Store app execution aliases
 * — the 0-byte reparse-point stubs under %LOCALAPPDATA%\Microsoft\WindowsApps
 * (e.g. pwsh.exe when PowerShell 7 is installed via the Store). access(2)
 * follows the reparse point to the real target, so it correctly reports the
 * alias as existing. Using existsSync here made a Store-installed pwsh 7
 * invisible to detection, causing mycc to wrongly fall back to PS 5.1.
 */
function fileExists(p: string): boolean {
  try {
    accessSync(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find a binary on PATH (like `which`/`where`). Returns the first matching
 * full path, or null. Honors PATHEXT on Windows.
 */
function onPath(name: string): string | null {
  const pathSep = delimiter; // ';' on Windows, ':' elsewhere
  const exts = (process.env.PATHEXT || '').split(pathSep).filter(Boolean);
  const dirs = (process.env.PATH || '').split(pathSep);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidates = [name, ...exts.map((ext) => name + ext)];
    for (const cand of candidates) {
      const full = join(dir, cand);
      if (!fileExists(full)) continue;
      try {
        // Regular file — accept.
        if (statSync(full).isFile()) {
          return full;
        }
      } catch {
        // statSync throws on some reparse points — notably the Microsoft
        // Store app execution aliases under
        // %LOCALAPPDATA%\Microsoft\WindowsApps (e.g. pwsh.exe when pwsh 7 is
        // installed via the Store). These are 0-byte reparse-point stubs
        // that resolve to the real binary at spawn time; EACCES/EIO on
        // statSync does NOT mean the target is unusable. existsSync already
        // confirmed the entry exists, so accept it and let exec() validate
        // by spawning. Without this, a Store-installed pwsh 7 is invisible
        // to detection and mycc wrongly falls back to PowerShell 5.1.
        return full;
      }
    }
  }
  return null;
}

/**
 * Detect PowerShell 7 (`pwsh`). Priority (first existing wins):
 *   1. `process.env.MYCC_PWSH` — explicit override path.
 *   2. `pwsh` / `pwsh.exe` on PATH.
 *   3. Well-known location: `<ProgramFiles>\PowerShell\7\pwsh.exe`.
 * Returns the absolute path, or null if pwsh 7 is not found.
 */
function detectPwsh7(): string | null {
  const override = process.env.MYCC_PWSH;
  if (override && fileExists(override)) {
    return override;
  }
  const pwshOnPath = onPath('pwsh');
  if (pwshOnPath) {
    return pwshOnPath;
  }
  const knownPwsh = join(
    process.env.ProgramFiles || 'C:\\Program Files',
    'PowerShell', '7', 'pwsh.exe',
  );
  if (fileExists(knownPwsh)) {
    return knownPwsh;
  }
  return null;
}

/**
 * Detect Windows PowerShell 5.1 (`powershell`). Priority (first existing
 * wins):
 *   1. `powershell` / `powershell.exe` on PATH.
 *   2. Well-known location:
 *      `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`.
 * Returns the absolute path, or null (should not happen on a supported
 * Windows system — 5.1 is always present).
 */
function detectPowershell5(): string | null {
  const psOnPath = onPath('powershell');
  if (psOnPath) {
    return psOnPath;
  }
  const knownPs = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  if (fileExists(knownPs)) {
    return knownPs;
  }
  return null;
}

/**
 * Detect the shell for the current process. Lazy + cached — the first call
 * performs the probe; subsequent calls return the cached result. Call once
 * at startup (lead.ts) to prime the cache and (on Windows 5.1) surface the
 * one-time "install pwsh 7 for best reliability" hint.
 *
 * @param reset - force re-detection (testing only).
 */
export function detectShell(reset = false): ShellInfo {
  if (cached && !reset) return cached;

  const platform = process.platform;
  if (platform === 'win32') {
    const pwshPath = detectPwsh7();
    if (pwshPath) {
      cached = { isWin: true, platform: 'Windows', shell: 'pwsh7', path: pwshPath };
    } else {
      const ps5Path = detectPowershell5();
      // 5.1 is always present on supported Windows; if somehow not found we
      // still commit to powershell5 (exec() will throw a clear spawn error
      // rather than silently picking a different shell).
      cached = { isWin: true, platform: 'Windows', shell: 'powershell5', path: ps5Path ?? 'powershell.exe' };
    }
    return cached;
  }

  if (platform === 'darwin') {
    cached = { isWin: false, platform: 'macOS', shell: 'zsh' };
    return cached;
  }

  if (platform === 'linux') {
    cached = { isWin: false, platform: 'Linux', shell: 'bash' };
    return cached;
  }

  // Unknown platform — fail loudly rather than guessing a shell, so a new
  // platform added without a detection branch surfaces immediately.
  throw new Error(`detectShell: unsupported platform '${platform}'`);
}

/**
 * Convenience accessor for the cached detection. Returns the cached result,
 * running detection once if it has not run yet.
 */
export function getShellInfo(): ShellInfo {
  return detectShell();
}