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

  describe('Neglected Mode', () => {
    describe('isNeglectedMode', () => {
      it('should return false initially', () => {
        expect(agentIO.isNeglectedMode()).toBe(false);
      });

      it('should return true after setNeglectedMode(true)', () => {
        agentIO.setNeglectedMode(true);
        expect(agentIO.isNeglectedMode()).toBe(true);
      });

      it('should return false after setNeglectedMode(false)', () => {
        agentIO.setNeglectedMode(true);
        expect(agentIO.isNeglectedMode()).toBe(true);

        agentIO.setNeglectedMode(false);
        expect(agentIO.isNeglectedMode()).toBe(false);
      });
    });

    describe('setNeglectedMode', () => {
      it('should set neglected mode to true', () => {
        agentIO.setNeglectedMode(true);
        expect(agentIO.isNeglectedMode()).toBe(true);
      });

      it('should set neglected mode to false', () => {
        agentIO.setNeglectedMode(true);
        agentIO.setNeglectedMode(false);
        expect(agentIO.isNeglectedMode()).toBe(false);
      });

      it('should handle multiple consecutive true calls', () => {
        agentIO.setNeglectedMode(true);
        agentIO.setNeglectedMode(true);
        agentIO.setNeglectedMode(true);
        expect(agentIO.isNeglectedMode()).toBe(true);
      });

      it('should handle multiple consecutive false calls', () => {
        agentIO.setNeglectedMode(false);
        agentIO.setNeglectedMode(false);
        expect(agentIO.isNeglectedMode()).toBe(false);
      });

      it('should handle rapid state changes', () => {
        agentIO.setNeglectedMode(true);
        expect(agentIO.isNeglectedMode()).toBe(true);

        agentIO.setNeglectedMode(false);
        expect(agentIO.isNeglectedMode()).toBe(false);

        agentIO.setNeglectedMode(true);
        expect(agentIO.isNeglectedMode()).toBe(true);
      });
    });

    describe('onNeglected', () => {
      it('should register callbacks', () => {
        const callback = vi.fn();
        agentIO.onNeglected(callback);

        // Trigger the callbacks manually through the internal state
        const callbacks = (agentIO as unknown as { onNeglectedCallbacks: Array<() => void> })
          .onNeglectedCallbacks;
        expect(callbacks).toContain(callback);
      });

      it('should register multiple callbacks', () => {
        const callback1 = vi.fn();
        const callback2 = vi.fn();
        const callback3 = vi.fn();

        agentIO.onNeglected(callback1);
        agentIO.onNeglected(callback2);
        agentIO.onNeglected(callback3);

        const callbacks = (agentIO as unknown as { onNeglectedCallbacks: Array<() => void> })
          .onNeglectedCallbacks;
        expect(callbacks).toHaveLength(3);
      });

      it('should call registered callbacks when triggered', () => {
        const callback1 = vi.fn();
        const callback2 = vi.fn();

        agentIO.onNeglected(callback1);
        agentIO.onNeglected(callback2);

        // Trigger callbacks
        const callbacks = (agentIO as unknown as { onNeglectedCallbacks: Array<() => void> })
          .onNeglectedCallbacks;
        callbacks.forEach((cb) => cb());

        expect(callback1).toHaveBeenCalledTimes(1);
        expect(callback2).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('isInteractionMode', () => {
    it('should return false when not in neglected mode and no active line editor', () => {
      expect(agentIO.isInteractionMode()).toBe(false);
    });

    it('should return true when in neglected mode', () => {
      agentIO.setNeglectedMode(true);
      expect(agentIO.isInteractionMode()).toBe(true);
    });

    it('should return true when line editor is active', () => {
      // Set active line editor
      (agentIO as unknown as { activeLineEditor: unknown }).activeLineEditor = {
        handleKey: vi.fn(),
        close: vi.fn(),
      };

      expect(agentIO.isInteractionMode()).toBe(true);
    });

    it('should return true when both neglected mode and line editor active', () => {
      agentIO.setNeglectedMode(true);
      (agentIO as unknown as { activeLineEditor: unknown }).activeLineEditor = {
        handleKey: vi.fn(),
        close: vi.fn(),
      };

      expect(agentIO.isInteractionMode()).toBe(true);
    });

    it('should return false after clearing both states', () => {
      agentIO.setNeglectedMode(true);
      (agentIO as unknown as { activeLineEditor: unknown }).activeLineEditor = {
        handleKey: vi.fn(),
        close: vi.fn(),
      };

      // Clear both
      agentIO.setNeglectedMode(false);
      (agentIO as unknown as { activeLineEditor: unknown }).activeLineEditor = null;

      expect(agentIO.isInteractionMode()).toBe(false);
    });
  });
});