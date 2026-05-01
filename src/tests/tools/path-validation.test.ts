/**
 * path-validation.test.ts - Tests for path validation across tools
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

// Patterns that ARE blocked by safePath (escape the workspace)
const blockedPatterns = [
  '../../../etc/passwd',
  '/etc/passwd',
  '/root/.ssh/id_rsa',
];

// Patterns that are NOT blocked (don't actually escape workspace on Linux)
// - URL-encoded paths are treated literally
// - Backslashes on Linux are literal characters
// - '....//' is not a valid traversal pattern
const allowedPatterns = [
  '..%2F..%2F..%2Fetc/passwd',
  '....//....//etc/passwd',
  '..\\..\\..\\windows\\system32',
];

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
    for (const pattern of blockedPatterns) {
      it(`should block path traversal pattern: ${pattern}`, async () => {
        const result = await readTool.handler(ctx, { path: pattern });
        expect(result).toContain('Error:');
      });
    }
  });

  describe('writeTool', () => {
    for (const pattern of blockedPatterns) {
      it(`should block path traversal pattern: ${pattern}`, async () => {
        const result = await writeTool.handler(ctx, {
          path: pattern,
          content: 'malicious',
        });
        expect(result).toContain('Error:');
      });
    }
  });

  describe('editTool', () => {
    for (const pattern of blockedPatterns) {
      it(`should block path traversal pattern: ${pattern}`, async () => {
        const result = await editTool.handler(ctx, {
          path: pattern,
          old_text: 'test',
          new_text: 'test',
        });
        expect(result).toContain('Error:');
      });
    }
  });
});