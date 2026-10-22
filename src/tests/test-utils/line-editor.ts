/**
 * line-editor.ts - Shared fixtures for LineEditor tests
 *
 * The `src/tests/line-editor/` suite (9 files) previously carried an
 * identical copy of `key()` / `charKey()` / `createMockStdout()` in each
 * file. Those copies are hoisted here so the per-file code is only the
 * behaviour under test.
 */

import { vi } from 'vitest';
import type { KeyInfo } from '../../utils/key-parser.js';

/**
 * Build a KeyInfo for a named key (e.g. 'return', 'left', 'backspace').
 */
export function key(name: string, options: Partial<KeyInfo> = {}): KeyInfo {
  return {
    name,
    ctrl: false,
    meta: false,
    shift: false,
    sequence: '',
    ...options,
  };
}

/**
 * Build a KeyInfo for a printable character.
 */
export function charKey(c: string): KeyInfo {
  return {
    name: '',
    ctrl: false,
    meta: false,
    shift: false,
    sequence: c,
  };
}

/**
 * Create a mock stdout stream suitable for LineEditor.
 */
export function createMockStdout(): NodeJS.WriteStream {
  return {
    write: vi.fn(),
    columns: 80,
    rows: 24,
    isTTY: true,
    on: vi.fn(),
    removeListener: vi.fn(),
  } as unknown as NodeJS.WriteStream;
}
