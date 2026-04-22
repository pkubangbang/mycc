import process from 'node:process';
import { spawn } from 'child_process';

interface EditorInfo {
  id: string;
  binary: string;
  isTerminalEditor: boolean;
}

// Known editors with their configurations
const KNOWN_EDITORS: EditorInfo[] = [
  { id: 'vscode', binary: 'code', isTerminalEditor: false },
  { id: 'vscode-insiders', binary: 'code-insiders', isTerminalEditor: false },
  { id: 'vscodium', binary: 'codium', isTerminalEditor: false },
  { id: 'sublime', binary: 'subl', isTerminalEditor: false },
  { id: 'atom', binary: 'atom', isTerminalEditor: false },
  { id: 'zed', binary: 'zed', isTerminalEditor: false },
  { id: 'webstorm', binary: 'webstorm', isTerminalEditor: false },
  { id: 'intellij', binary: 'idea', isTerminalEditor: false },
  { id: 'textmate', binary: 'mate', isTerminalEditor: false },
  { id: 'vim', binary: 'vim', isTerminalEditor: true },
  { id: 'neovim', binary: 'nvim', isTerminalEditor: true },
  { id: 'nano', binary: 'nano', isTerminalEditor: true },
  { id: 'emacs', binary: 'emacs', isTerminalEditor: true },
];

// Editors that support --goto for line:column
const GOTO_EDITORS = ['vscode', 'vscode-insiders', 'vscodium', 'sublime', 'atom', 'zed'];

/**
 * Parse editor string into EditorInfo
 * Unlike env-editor, this preserves the full binary name for unknown editors
 */
export function getEditor(editorStr: string): EditorInfo {
  const trimmed = editorStr.trim();
  const needle = trimmed.toLowerCase();

  // Check for known editors
  for (const editor of KNOWN_EDITORS) {
    if (needle === editor.id || needle === editor.binary) {
      return editor;
    }
  }

  // For unknown editors, use the full string as both id and binary
  // This fixes the bug where 'xdg-open' becomes 'xdg'
  return {
    id: needle,
    binary: trimmed,
    isTerminalEditor: false,
  };
}

/**
 * Get default editor from environment
 */
export function defaultEditor(): EditorInfo {
  const editor = process.env.EDITOR || process.env.VISUAL;
  if (!editor) {
    throw new Error(
      '$EDITOR environment variable is not set.\n' +
      'Please set it to your preferred editor. Add to ~/.mycc-store/.env:\n' +
      '  export EDITOR=code     # for VS Code\n' +
      '  export EDITOR=vim     # for Vim\n' +
      '  export EDITOR=nano    # for Nano'
    );
  }
  return getEditor(editor);
}

/**
 * Parse file path with optional line:column (e.g., "file.ts:10:5")
 */
export function parseFile(file: string): { file: string; line?: number; column?: number } {
  const match = file.match(/^(.+?)(?::(\d+))?(?::(\d+))?$/);
  if (!match) return { file };
  return {
    file: match[1],
    line: match[2] ? parseInt(match[2], 10) : undefined,
    column: match[3] ? parseInt(match[3], 10) : undefined,
  };
}

/**
 * Open files in editor
 */
export async function openEditor(files: string[], options?: { editor?: string }): Promise<void> {
  const editor = options?.editor ? getEditor(options.editor) : defaultEditor();
  const args: string[] = [];

  for (const file of files) {
    const parsed = parseFile(file);

    if (GOTO_EDITORS.includes(editor.id) && parsed.line) {
      // Editors that support --goto
      args.push('--goto');
      args.push(parsed.column ? `${parsed.file}:${parsed.line}:${parsed.column}` : `${parsed.file}:${parsed.line}`);
    } else if ((editor.id === 'vim' || editor.id === 'neovim') && parsed.line) {
      // Vim/Neovim cursor positioning
      args.push(`+call cursor(${parsed.line}, ${parsed.column || 1})`);
      args.push(parsed.file);
    } else {
      // Default: just pass the file
      args.push(parsed.file);
    }
  }

  const stdio = editor.isTerminalEditor ? 'inherit' : 'ignore';

  try {
    if (editor.isTerminalEditor) {
      // For terminal editors, wait for them to complete
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(editor.binary, args, {
          stdio,
          shell: false,
        });
        proc.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`Editor exited with code ${code}`));
          }
        });
        proc.on('error', (err) => {
          reject(err);
        });
      });
    } else {
      // For GUI editors, launch detached (don't wait)
      const proc = spawn(editor.binary, args, {
        detached: true,
        stdio,
        shell: false,
      });
      proc.unref();
    }
  } catch (err) {
    throw new Error(`Failed to open editor: ${(err as Error).message}`, { cause: err });
  }
}