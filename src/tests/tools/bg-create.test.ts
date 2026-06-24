/**
 * bg-create.test.ts - Tests for the bg_create tool
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { bgCreateTool } from '../../tools/bg_create.js';
import { createMockContext, createTempDir, removeTempDir } from './test-utils.js';
import type { AgentContext } from '../../types.js';

describe('bgCreateTool', () => {
  let tempDir: string;
  let ctx: AgentContext;

  beforeEach(() => {
    tempDir = createTempDir();
    ctx = createMockContext(tempDir);
    vi.clearAllMocks();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  describe('happy path', () => {
    it('should run a background command and return pid', async () => {
      vi.mocked(ctx.bg!.runCommand).mockResolvedValueOnce(42);
      const result = await bgCreateTool.handler(ctx, { command: 'sleep 10', intent: 'RUN SYSTEM TO test background task' });
      expect(result).toBe('OK: 42');
      expect(ctx.bg!.runCommand).toHaveBeenCalledWith('sleep 10');
    });

    it('should request grant before running', async () => {
      vi.mocked(ctx.bg!.runCommand).mockResolvedValueOnce(1);
      await bgCreateTool.handler(ctx, { command: 'echo hello', intent: 'RUN SYSTEM TO test grant' });
      expect(ctx.core.requestGrant).toHaveBeenCalledWith('bash', { command: 'echo hello', intent: 'RUN SYSTEM TO test grant' });
    });
  });

  describe('input validation', () => {
    it('should return error for missing command', async () => {
      const result = await bgCreateTool.handler(ctx, { intent: 'test' });
      expect(result).toContain('Error');
      expect(result).toContain('command parameter is required');
    });
    it('should return error for non-string command', async () => {
      const result = await bgCreateTool.handler(ctx, { command: 123, intent: 'test' });
      expect(result).toContain('Error');
      expect(result).toContain('command parameter is required');
    });
    it('should return error for empty command string', async () => {
      const result = await bgCreateTool.handler(ctx, { command: '', intent: 'test' });
      expect(result).toContain('Error');
      expect(result).toContain('command parameter is required');
    });
    it('should return error for missing intent', async () => {
      const result = await bgCreateTool.handler(ctx, { command: 'echo hello' });
      expect(result).toContain('Error');
      expect(result).toContain('intent parameter is required');
    });
    it('should return error for non-string intent', async () => {
      const result = await bgCreateTool.handler(ctx, { command: 'echo hello', intent: 42 });
      expect(result).toContain('Error');
      expect(result).toContain('intent parameter is required');
    });
  });

  describe('grant rejection', () => {
    it('should return reason when grant is denied', async () => {
      vi.mocked(ctx.core.requestGrant).mockResolvedValueOnce({ approved: false, reason: 'Operation not permitted in plan mode' });
      const result = await bgCreateTool.handler(ctx, { command: 'rm -rf /', intent: 'dangerous' });
      expect(result).toContain('Operation not permitted in plan mode');
      expect(ctx.bg!.runCommand).not.toHaveBeenCalled();
    });
    it('should return default reason when grant has no reason', async () => {
      vi.mocked(ctx.core.requestGrant).mockResolvedValueOnce({ approved: false });
      const result = await bgCreateTool.handler(ctx, { command: 'some command', intent: 'test' });
      expect(result).toContain('Operation not permitted');
      expect(ctx.bg!.runCommand).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should handle runCommand throwing an error', async () => {
      vi.mocked(ctx.bg!.runCommand).mockRejectedValueOnce(new Error('Failed to spawn process'));
      const result = await bgCreateTool.handler(ctx, { command: 'bad-command', intent: 'RUN SYSTEM TO test error' });
      expect(result).toContain('Error');
      expect(result).toContain('Failed to spawn process');
    });
  });

  describe('tool metadata', () => {
    it('should have correct name', () => { expect(bgCreateTool.name).toBe('bg_create'); });
    it('should have correct scope', () => { expect(bgCreateTool.scope).toEqual(['main', 'child']); });
    it('should require command and intent', () => {
      expect(bgCreateTool.input_schema.required).toContain('command');
      expect(bgCreateTool.input_schema.required).toContain('intent');
    });
  });
});