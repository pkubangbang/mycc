/**
 * path-validation.test.ts - Tests for path validation across tools
 *
 * Strengthened (PR-B, test-strength gap flagged in dir-3/dir-4 code reviews):
 * the old assertions used a bare `toContain('Error:')`, which is satisfied by
 * ANY error string — including an incidental error from a regression that
 * silently allowed the traversal. Each assertion now pins the EXACT rejection
 * reason each tool emits for the pattern under test, locking the security
 * guard end-to-end:
 *   - Traversal patterns (`../../../etc/passwd`) resolve outside the workspace
 *     but are NOT sensitive system paths → the tools call
 *     requestExternalPathAccess(), the mock denies with reason
 *     'Path escapes workspace', and the tools return `Error: Path escapes workspace`.
 *   - Absolute system paths (`/etc/passwd`, `/root/.ssh/id_rsa`) resolve
 *     outside the workspace AND match checkSensitivePath() → write/edit
 *     short-circuit to `Error: Cannot <write|edit> to <path> — <reason>.
 *     This path is protected from automated modification.` BEFORE the
 *     external-access check. read has no sensitive-path guard, so it still
 *     goes through requestExternalPathAccess → `Error: Path escapes workspace`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readTool } from '../../tools/read.js';
import { writeTool } from '../../tools/write.js';
import { editTool } from '../../tools/edit.js';
import {
  createMockContext,
  createTempDir,
  removeTempDir,
} from './test-utils.js';
import type { AgentContext } from '../../types.js';

// Traversal patterns: resolve outside the workspace but are not sensitive
// system paths, so they reach the requestExternalPathAccess() denial.
const traversalPatterns = ['../../../etc/passwd'];

// Absolute system paths: resolve outside the workspace AND match
// checkSensitivePath(), so write/edit short-circuit to the protected-path
// rejection. (read has no sensitive-path guard, so it denies via
// requestExternalPathAccess regardless.)
const sensitiveSystemPaths = ['/etc/passwd', '/root/.ssh/id_rsa'];

describe('path validation', () => {
  let tempDir: string;
  let ctx: AgentContext;

  beforeEach(() => {
    tempDir = createTempDir();
    ctx = createMockContext(tempDir);
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  describe('readTool', () => {
    // read has no checkSensitivePath guard — every external path goes through
    // requestExternalPathAccess(), which the mock denies with 'Path escapes workspace'.
    for (const pattern of [...traversalPatterns, ...sensitiveSystemPaths]) {
      it(`should block path traversal pattern: ${pattern}`, async () => {
        const result = await readTool.handler(ctx, { path: pattern });
        expect(result).toContain('Error: Path escapes workspace');
      });
    }
  });

  describe('writeTool', () => {
    for (const pattern of traversalPatterns) {
      it(`should block path traversal pattern: ${pattern}`, async () => {
        const result = await writeTool.handler(ctx, {
          path: pattern,
          content: 'malicious',
        });
        // Traversal patterns reach the external-access denial.
        expect(result).toContain('Error: Path escapes workspace');
      });
    }
    for (const pattern of sensitiveSystemPaths) {
      it(`should block sensitive system path: ${pattern}`, async () => {
        const result = await writeTool.handler(ctx, {
          path: pattern,
          content: 'malicious',
        });
        // Sensitive system paths short-circuit to the protected-path
        // rejection before the external-access check — assert that exact
        // branch, not a generic 'Error:'.
        expect(result).toContain('Error: Cannot write to ');
        expect(result).toContain('protected from automated modification');
      });
    }
  });

  describe('editTool', () => {
    for (const pattern of traversalPatterns) {
      it(`should block path traversal pattern: ${pattern}`, async () => {
        const result = await editTool.handler(ctx, {
          path: pattern,
          old_text: 'test',
          new_text: 'test',
        });
        // Traversal patterns reach the external-access denial.
        expect(result).toContain('Error: Path escapes workspace');
      });
    }
    for (const pattern of sensitiveSystemPaths) {
      it(`should block sensitive system path: ${pattern}`, async () => {
        const result = await editTool.handler(ctx, {
          path: pattern,
          old_text: 'test',
          new_text: 'test',
        });
        // Sensitive system paths short-circuit to the protected-path
        // rejection before the external-access check — assert that exact
        // branch, not a generic 'Error:'.
        expect(result).toContain('Error: Cannot edit ');
        expect(result).toContain('protected from automated modification');
      });
    }
  });
});