/**
 * editor.ts - Cross-platform editor defaults
 *
 * Provides platform-specific default editors and suggestions
 */

import fs from 'fs';
import path from 'path';
import { isWindows, isMacOS } from './paths.js';

/**
 * Get the default editor for the current platform
 * Priority: env vars (EDITOR, VISUAL) > platform default
 */
export function getDefaultEditor(): string {
  // Check environment variables first
  if (process.env.EDITOR) return process.env.EDITOR;
  if (process.env.VISUAL) return process.env.VISUAL;

  // Platform-specific defaults (user-friendly)
  if (isWindows()) {
    return 'notepad';
  }

  // Linux and macOS: nano is more user-friendly than vim
  return 'nano';
}

/**
 * Get common editor suggestions for the current platform
 */
function getEditorSuggestions(): string[] {
  if (isWindows()) {
    return ['notepad', 'code', 'notepad++', 'vim'];
  }

  if (isMacOS()) {
    return ['nano', 'code', 'vim', 'subl', 'emacs'];
  }

  // Linux
  return ['nano', 'code', 'vim', 'emacs', 'gedit'];
}

/**
 * Get help text for editor prompt
 */
export function getEditorHelpText(): string {
  const suggestions = getEditorSuggestions();
  return `Common values: ${suggestions.join(', ')}`;
}

/**
 * Extract the binary name from a raw editor input string.
 * Handles: bare names, absolute paths, quoted paths, and trailing arguments.
 */
function extractBinary(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0];
    const closeIdx = trimmed.indexOf(quote, 1);
    if (closeIdx === -1) {
      return trimmed.slice(1);
    }
    return trimmed.slice(1, closeIdx);
  }
  return trimmed.split(/\s+/)[0];
}

/**
 * Validate that an editor binary exists.
 * Returns true if the binary is found, or an error message string if not.
 */
export function validateEditor(rawValue: string): boolean | string {
  const binaryPath = extractBinary(rawValue);
  if (!binaryPath) {
    return true; // empty — wizard will use default
  }

  // Absolute path: check directly
  if (path.isAbsolute(binaryPath)) {
    try {
      fs.accessSync(binaryPath, fs.constants.X_OK);
      return true;
    } catch {
      return `"${binaryPath}" does not exist or is not executable.`;
    }
  }

  // Bare name: search PATH
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);

  if (isWindows()) {
    const pathext = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM;.VBS;.PS1')
      .split(';')
      .filter(Boolean);

    for (const dir of pathDirs) {
      for (const ext of pathext) {
        try {
          fs.accessSync(path.join(dir, binaryPath + ext), fs.constants.X_OK);
          return true;
        } catch {
          /* try next extension */
        }
      }
      try {
        fs.accessSync(path.join(dir, binaryPath), fs.constants.X_OK);
        return true;
      } catch {
        /* try next directory */
      }
    }
  } else {
    for (const dir of pathDirs) {
      try {
        fs.accessSync(path.join(dir, binaryPath), fs.constants.X_OK);
        return true;
      } catch {
        /* try next directory */
      }
    }
  }

  return `"${binaryPath}" not found in PATH. Is the editor installed?`;
}
