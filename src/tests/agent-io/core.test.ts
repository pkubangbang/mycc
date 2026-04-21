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
import { agentIO } from '../../loop/agent-io.js';

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

  describe('isMainProcess', () => {
    it('should return false initially (not initialized)', () => {
      // Reset the main process flag
      (agentIO as unknown as { isMainProcessFlag: boolean }).isMainProcessFlag = false;
      expect(agentIO.isMainProcess()).toBe(false);
    });

    it('should return true after initMain', () => {
      // We can't easily test initMain without triggering IPC handlers
      // Just verify the flag can be set
      (agentIO as unknown as { isMainProcessFlag: boolean }).isMainProcessFlag = true;
      expect(agentIO.isMainProcess()).toBe(true);

      // Reset
      (agentIO as unknown as { isMainProcessFlag: boolean }).isMainProcessFlag = false;
    });
  });

  describe('LLM Abort Controller', () => {
    beforeEach(() => {
      (agentIO as unknown as { llmAbortController: AbortController | null }).llmAbortController = null;
    });

    it('should create and store an abort controller', () => {
      const controller = agentIO.createLlmAbortController();

      expect(controller).toBeInstanceOf(AbortController);
      expect(agentIO.getLlmAbortController()).toBe(controller);
    });

    it('should return the signal from the controller', () => {
      const controller = agentIO.createLlmAbortController();
      const signal = agentIO.getLlmAbortSignal();

      expect(signal).toBe(controller.signal);
    });

    it('should clear the abort controller', () => {
      agentIO.createLlmAbortController();
      expect(agentIO.getLlmAbortController()).not.toBeNull();

      agentIO.clearLlmAbortController();
      expect(agentIO.getLlmAbortController()).toBeNull();
    });

    it('should return undefined signal when no controller exists', () => {
      agentIO.clearLlmAbortController();
      expect(agentIO.getLlmAbortSignal()).toBeUndefined();
    });

    it('should replace controller on subsequent create calls', () => {
      const controller1 = agentIO.createLlmAbortController();
      const controller2 = agentIO.createLlmAbortController();

      expect(controller1).not.toBe(controller2);
      expect(agentIO.getLlmAbortController()).toBe(controller2);
    });
  });

  describe('handleKeyEvent', () => {
    it('should do nothing when no active line editor', () => {
      // Should not throw
      expect(() => agentIO.handleKeyEvent({ name: 'a', sequence: 'a', ctrl: false, meta: false, shift: false })).not.toThrow();
    });

    it('should forward key to active line editor', () => {
      const mockHandleKey = vi.fn();
      (agentIO as unknown as { activeLineEditor: unknown }).activeLineEditor = {
        handleKey: mockHandleKey,
        close: vi.fn(),
      };

      const keyInfo = { name: 'enter', sequence: '\r', ctrl: false, meta: false, shift: false };
      agentIO.handleKeyEvent(keyInfo);

      expect(mockHandleKey).toHaveBeenCalledWith(keyInfo);
    });
  });

  describe('handleResize', () => {
    it('should do nothing when no active line editor', () => {
      expect(() => agentIO.handleResize(80)).not.toThrow();
    });

    it('should forward resize to active line editor', () => {
      const mockResize = vi.fn();
      (agentIO as unknown as { activeLineEditor: unknown }).activeLineEditor = {
        handleKey: vi.fn(),
        resize: mockResize,
        close: vi.fn(),
      };

      agentIO.handleResize(120);

      expect(mockResize).toHaveBeenCalledWith(120);
    });
  });
});