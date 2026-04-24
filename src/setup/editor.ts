/**
 * editor.ts - Cross-platform editor defaults
 *
 * Provides platform-specific default editors and suggestions
 */

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
export function getEditorSuggestions(): string[] {
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