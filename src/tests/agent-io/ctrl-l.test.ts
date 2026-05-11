import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { KeyInfo } from '../../utils/key-parser.js';

// Mock LineEditor before importing agent-io
const mockLineEditor = {
  handleKey: vi.fn(),
  resize: vi.fn(),
  getHistory: vi.fn().mockReturnValue([]),
  close: vi.fn(),
  clearScreen: vi.fn(),
  setWhisper: vi.fn(),
};

vi.mock('../../utils/line-editor.js', () => {
  return {
    LineEditor: vi.fn().mockImplementation(() => mockLineEditor),
  };
});

// Import after mocking
import { agentIO } from '../../loop/agent-io.js';

/**
 * Helper to create a Ctrl+L KeyInfo
 */
function ctrlLKey(): KeyInfo {
  return {
    name: 'l',
    ctrl: true,
    meta: false,
    shift: false,
    sequence: '',
  };
}

/**
 * Helper to create a regular key
 */
function regularKey(name: string): KeyInfo {
  return {
    name,
    ctrl: false,
    meta: false,
    shift: false,
    sequence: '',
  };
}

describe('agent-io - Ctrl+L handling', () => {
  let mockTime: number;
  let dateNowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    // Mock Date.now to return controlled time
    mockTime = 1000000;
    dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => mockTime);

    // Reset singleton state
    (agentIO as unknown as { lastCtrlLTime: number | null }).lastCtrlLTime = null;
    (agentIO as unknown as { whisperTimeout: ReturnType<typeof setTimeout> | null }).whisperTimeout = null;
    (agentIO as unknown as { activeLineEditor: unknown }).activeLineEditor = null;
    (agentIO as unknown as { onDoubleCtrlLCallback: (() => void) | null }).onDoubleCtrlLCallback = null;
    vi.clearAllMocks();
  });

  afterEach(() => {
    dateNowSpy?.mockRestore();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * Helper to advance the mocked Date.now() time
   */
  function advanceMockTime(ms: number) {
    mockTime += ms;
    dateNowSpy.mockImplementation(() => mockTime);
  }

  describe('handleKeyEvent - Ctrl+L', () => {
    it('should do nothing if no active line editor', () => {
      (agentIO as unknown as { activeLineEditor: unknown }).activeLineEditor = null;
      agentIO.handleKeyEvent(ctrlLKey());
      expect(mockLineEditor.clearScreen).not.toHaveBeenCalled();
    });

    it('should clear screen on first Ctrl+L', () => {
      (agentIO as unknown as { activeLineEditor: unknown }).activeLineEditor = mockLineEditor;
      agentIO.handleKeyEvent(ctrlLKey());
      expect(mockLineEditor.clearScreen).toHaveBeenCalled();
    });

    it('should show whisper line on first Ctrl+L', () => {
      (agentIO as unknown as { activeLineEditor: unknown }).activeLineEditor = mockLineEditor;
      agentIO.handleKeyEvent(ctrlLKey());
      expect(mockLineEditor.setWhisper).toHaveBeenCalledWith(
        'Press Ctrl+L again to clear history',
        expect.any(Number)
      );
    });

    it('should set lastCtrlLTime on first Ctrl+L', () => {
      (agentIO as unknown as { activeLineEditor: unknown }).activeLineEditor = mockLineEditor;
      agentIO.handleKeyEvent(ctrlLKey());
      expect((agentIO as unknown as { lastCtrlLTime: number | null }).lastCtrlLTime).not.toBeNull();
    });

    it('should execute callback on double Ctrl+L within 3 seconds', () => {
      (agentIO as unknown as { activeLineEditor: unknown }).activeLineEditor = mockLineEditor;
      const callback = vi.fn();
      agentIO.setDoubleCtrlLCallback(callback);

      // First Ctrl+L
      agentIO.handleKeyEvent(ctrlLKey());
      expect(callback).not.toHaveBeenCalled();

      // Second Ctrl+L (within 3s)
      vi.advanceTimersByTime(1000);
      agentIO.handleKeyEvent(ctrlLKey());
      expect(callback).toHaveBeenCalled();
    });

    it('should clear whisper line on double Ctrl+L', () => {
      (agentIO as unknown as { activeLineEditor: unknown }).activeLineEditor = mockLineEditor;

      // Set up callback for double-press to work
      agentIO.setDoubleCtrlLCallback(() => {});

      // First press
      agentIO.handleKeyEvent(ctrlLKey());
      expect(mockLineEditor.setWhisper).toHaveBeenCalledWith(
        'Press Ctrl+L again to clear history',
        expect.any(Number)
      );

      // Clear mock before second press
      mockLineEditor.setWhisper.mockClear();

      // Advance time slightly (within 3s window)
      advanceMockTime(100);

      // Second press (within 3s window)
      agentIO.handleKeyEvent(ctrlLKey());

      // Should call setWhisper with null during clearCtrlLState
      expect(mockLineEditor.setWhisper).toHaveBeenCalledWith(null);
    });

    it('should NOT execute callback on Ctrl+L after 3 seconds', () => {
      (agentIO as unknown as { activeLineEditor: unknown }).activeLineEditor = mockLineEditor;
      const callback = vi.fn();
      agentIO.setDoubleCtrlLCallback(callback);

      // First Ctrl+L
      agentIO.handleKeyEvent(ctrlLKey());

      // Wait more than 3 seconds (advance mock time)
      advanceMockTime(3500);

      // Second Ctrl+L (after 3s timeout)
      agentIO.handleKeyEvent(ctrlLKey());

      // Should NOT call callback, just clear screen again
      expect(callback).not.toHaveBeenCalled();
      expect(mockLineEditor.clearScreen).toHaveBeenCalledTimes(2);
    });

    it('should reset lastCtrlLTime after 3 second timeout', () => {
      (agentIO as unknown as { activeLineEditor: unknown }).activeLineEditor = mockLineEditor;
      agentIO.handleKeyEvent(ctrlLKey());
      expect((agentIO as unknown as { lastCtrlLTime: number | null }).lastCtrlLTime).not.toBeNull();

      // Advance past the timeout (the timeout clears lastCtrlLTime)
      vi.advanceTimersByTime(3500);

      // The timeout should have cleared lastCtrlLTime
      expect((agentIO as unknown as { lastCtrlLTime: number | null }).lastCtrlLTime).toBeNull();
    });

    it('should NOT execute callback if not set', () => {
      (agentIO as unknown as { activeLineEditor: unknown }).activeLineEditor = mockLineEditor;
      // Don't set callback
      agentIO.setDoubleCtrlLCallback(null);

      agentIO.handleKeyEvent(ctrlLKey());
      advanceMockTime(100);
      agentIO.handleKeyEvent(ctrlLKey());

      // Should just clear screen without error
      expect(mockLineEditor.clearScreen).toHaveBeenCalled();
    });

    it('should forward non-Ctrl+L keys to LineEditor', () => {
      (agentIO as unknown as { activeLineEditor: unknown }).activeLineEditor = mockLineEditor;
      const key = regularKey('a');
      agentIO.handleKeyEvent(key);
      expect(mockLineEditor.handleKey).toHaveBeenCalledWith(key);
    });

    it('should NOT forward Ctrl+L to LineEditor', () => {
      (agentIO as unknown as { activeLineEditor: unknown }).activeLineEditor = mockLineEditor;
      agentIO.handleKeyEvent(ctrlLKey());
      expect(mockLineEditor.handleKey).not.toHaveBeenCalled();
    });
  });

  describe('setDoubleCtrlLCallback', () => {
    it('should set callback', () => {
      const callback = vi.fn();
      agentIO.setDoubleCtrlLCallback(callback);
      expect((agentIO as unknown as { onDoubleCtrlLCallback: (() => void) | null }).onDoubleCtrlLCallback).toBe(callback);
    });

    it('should allow clearing callback', () => {
      const callback = vi.fn();
      agentIO.setDoubleCtrlLCallback(callback);
      agentIO.setDoubleCtrlLCallback(null);
      expect((agentIO as unknown as { onDoubleCtrlLCallback: (() => void) | null }).onDoubleCtrlLCallback).toBeNull();
    });
  });

  describe('clearCtrlLState (internal)', () => {
    it('should clear lastCtrlLTime', () => {
      (agentIO as unknown as { activeLineEditor: unknown }).activeLineEditor = mockLineEditor;

      agentIO.handleKeyEvent(ctrlLKey()); // Sets lastCtrlLTime

      // Double press to trigger clearCtrlLState
      agentIO.setDoubleCtrlLCallback(() => {});
      advanceMockTime(100);
      agentIO.handleKeyEvent(ctrlLKey());

      expect((agentIO as unknown as { lastCtrlLTime: number | null }).lastCtrlLTime).toBeNull();
    });

    it('should clear whisperTimeout', () => {
      (agentIO as unknown as { activeLineEditor: unknown }).activeLineEditor = mockLineEditor;
      agentIO.handleKeyEvent(ctrlLKey());

      // whisperTimeout should be set
      expect((agentIO as unknown as { whisperTimeout: ReturnType<typeof setTimeout> | null }).whisperTimeout).not.toBeNull();

      // Double press to trigger clearCtrlLState
      agentIO.setDoubleCtrlLCallback(() => {});
      advanceMockTime(100);
      agentIO.handleKeyEvent(ctrlLKey());

      expect((agentIO as unknown as { whisperTimeout: ReturnType<typeof setTimeout> | null }).whisperTimeout).toBeNull();
    });

    it('should call setWhisper(null) on active line editor', () => {
      (agentIO as unknown as { activeLineEditor: unknown }).activeLineEditor = mockLineEditor;

      agentIO.handleKeyEvent(ctrlLKey());

      // Double press to trigger clearCtrlLState
      agentIO.setDoubleCtrlLCallback(() => {});
      advanceMockTime(100);
      mockLineEditor.setWhisper.mockClear(); // Clear previous calls
      agentIO.handleKeyEvent(ctrlLKey());

      // setWhisper should be called with null
      expect(mockLineEditor.setWhisper).toHaveBeenCalledWith(null);
    });
  });

  describe('edge cases', () => {
    it('should handle rapid Ctrl+L presses', () => {
      (agentIO as unknown as { activeLineEditor: unknown }).activeLineEditor = mockLineEditor;
      const callback = vi.fn();
      agentIO.setDoubleCtrlLCallback(callback);

      // Rapid double press
      agentIO.handleKeyEvent(ctrlLKey());
      advanceMockTime(50);
      agentIO.handleKeyEvent(ctrlLKey());

      expect(callback).toHaveBeenCalled();
    });

    it('should handle callback throwing error', () => {
      (agentIO as unknown as { activeLineEditor: unknown }).activeLineEditor = mockLineEditor;
      const callback = vi.fn().mockImplementation(() => {
        throw new Error('Test error');
      });
      agentIO.setDoubleCtrlLCallback(callback);

      agentIO.handleKeyEvent(ctrlLKey());
      advanceMockTime(100);
      // Should not throw
      expect(() => agentIO.handleKeyEvent(ctrlLKey())).not.toThrow();
    });

    it('should handle triple Ctrl+L presses', () => {
      (agentIO as unknown as { activeLineEditor: unknown }).activeLineEditor = mockLineEditor;
      const callback = vi.fn();
      agentIO.setDoubleCtrlLCallback(callback);

      // First press
      agentIO.handleKeyEvent(ctrlLKey());
      advanceMockTime(100);
      // Second press (double)
      agentIO.handleKeyEvent(ctrlLKey());
      expect(callback).toHaveBeenCalledTimes(1);

      // Third press (should be treated as first of new sequence)
      advanceMockTime(100);
      agentIO.handleKeyEvent(ctrlLKey());
      expect(callback).toHaveBeenCalledTimes(1); // Not called again
      expect(mockLineEditor.setWhisper).toHaveBeenCalled();
    });
  });
});