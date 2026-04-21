import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock LineEditor before importing agent-io
vi.mock('../../utils/line-editor.js', () => {
  return {
    LineEditor: vi.fn().mockImplementation(() => ({
      handleKey: vi.fn(),
      resize: vi.fn(),
      getHistory: vi.fn().mockReturnValue([]),
      close: vi.fn(),
    })),
  };
});

// Import after mocking
import { agentIO, type ExecOptions } from '../../loop/agent-io.js';

describe('agent-io', () => {
  beforeEach(() => {
    // Reset singleton state before each test
    (agentIO as unknown as { neglectedModeFlag: boolean }).neglectedModeFlag = false;
    (agentIO as unknown as { activeLineEditor: unknown }).activeLineEditor = null;
    (agentIO as unknown as { outputBuffer: Array<{ method: string; args: unknown[] }> }).outputBuffer =
      [];
    (agentIO as unknown as { onNeglectedCallbacks: Array<() => void> }).onNeglectedCallbacks = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('exec validation', () => {
    it('should throw error for invalid timeout (zero)', async () => {
      const options: ExecOptions = {
        cwd: '/tmp',
        command: 'echo test',
        timeout: 0,
      };

      await expect(agentIO.exec(options)).rejects.toThrow(
        'timeout must be an integer between 1 and 30'
      );
    });

    it('should throw error for invalid timeout (negative)', async () => {
      const options: ExecOptions = {
        cwd: '/tmp',
        command: 'echo test',
        timeout: -1,
      };

      await expect(agentIO.exec(options)).rejects.toThrow(
        'timeout must be an integer between 1 and 30'
      );
    });

    it('should throw error for invalid timeout (too large)', async () => {
      const options: ExecOptions = {
        cwd: '/tmp',
        command: 'echo test',
        timeout: 31,
      };

      await expect(agentIO.exec(options)).rejects.toThrow(
        'timeout must be an integer between 1 and 30'
      );
    });

    it('should throw error for non-integer timeout', async () => {
      const options: ExecOptions = {
        cwd: '/tmp',
        command: 'echo test',
        timeout: 5.5,
      };

      await expect(agentIO.exec(options)).rejects.toThrow(
        'timeout must be an integer between 1 and 30'
      );
    });

    it('should accept valid timeout (minimum)', async () => {
      const options: ExecOptions = {
        cwd: '/tmp',
        command: 'echo test',
        timeout: 1,
      };

      // This should not throw validation error (might fail on setsid but that's ok)
      const result = await agentIO.exec(options);
      expect(result).toBeDefined();
    });

    it('should accept valid timeout (maximum)', async () => {
      const options: ExecOptions = {
        cwd: '/tmp',
        command: 'echo test',
        timeout: 30,
      };

      const result = await agentIO.exec(options);
      expect(result).toBeDefined();
    });
  });
});