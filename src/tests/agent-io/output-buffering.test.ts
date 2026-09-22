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
  // Console mocks
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Reset singleton state before each test
    (agentIO as unknown as { neglectedModeFlag: boolean }).neglectedModeFlag = false;
    (agentIO as unknown as { activeLineEditor: unknown }).activeLineEditor = null;
    (agentIO as unknown as { outputBuffer: Array<{ method: string; args: unknown[] }> }).outputBuffer =
      [];
    (agentIO as unknown as { onNeglectedCallbacks: Set<() => void> }).onNeglectedCallbacks = new Set();

    // Mock console methods
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Output Buffering', () => {
    describe('log', () => {
      it('should output directly when not in interaction mode', () => {
        agentIO.log('test message');

        expect(consoleLogSpy).toHaveBeenCalledTimes(1);
        expect(consoleLogSpy).toHaveBeenCalledWith('test message');
      });

      it('should buffer when in neglected mode', () => {
        agentIO.setNeglectedMode(true);

        agentIO.log('buffered message');

        expect(consoleLogSpy).not.toHaveBeenCalled();
        const buffer = (agentIO as unknown as { outputBuffer: Array<{ method: string; args: unknown[] }> })
          .outputBuffer;
        expect(buffer).toHaveLength(1);
        expect(buffer[0]).toEqual({ method: 'log', args: ['buffered message'] });
      });

      it('should buffer when line editor is active', () => {
        (agentIO as unknown as { activeLineEditor: unknown }).activeLineEditor = {
          handleKey: vi.fn(),
          close: vi.fn(),
        };

        agentIO.log('buffered during prompt');

        expect(consoleLogSpy).not.toHaveBeenCalled();
        const buffer = (agentIO as unknown as { outputBuffer: Array<{ method: string; args: unknown[] }> })
          .outputBuffer;
        expect(buffer).toHaveLength(1);
      });


    });

    describe('warn', () => {
      it('should output directly when not in interaction mode', () => {
        agentIO.warn('warning message');

        expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
        expect(consoleWarnSpy).toHaveBeenCalledWith('warning message');
      });

      it('should buffer when in neglected mode', () => {
        agentIO.setNeglectedMode(true);

        agentIO.warn('buffered warning');

        expect(consoleWarnSpy).not.toHaveBeenCalled();
        const buffer = (agentIO as unknown as { outputBuffer: Array<{ method: string; args: unknown[] }> })
          .outputBuffer;
        expect(buffer).toHaveLength(1);
        expect(buffer[0]).toEqual({ method: 'warn', args: ['buffered warning'] });
      });

      it('should buffer when line editor is active', () => {
        (agentIO as unknown as { activeLineEditor: unknown }).activeLineEditor = {
          handleKey: vi.fn(),
          close: vi.fn(),
        };

        agentIO.warn('buffered warning during prompt');

        expect(consoleWarnSpy).not.toHaveBeenCalled();
        const buffer = (agentIO as unknown as { outputBuffer: Array<{ method: string; args: unknown[] }> })
          .outputBuffer;
        expect(buffer).toHaveLength(1);
      });
    });

    describe('error', () => {
      it('should output directly when not in interaction mode', () => {
        agentIO.error('error message');

        expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
        expect(consoleErrorSpy).toHaveBeenCalledWith('error message');
      });

      it('should buffer when in neglected mode', () => {
        agentIO.setNeglectedMode(true);

        agentIO.error('buffered error');

        expect(consoleErrorSpy).not.toHaveBeenCalled();
        const buffer = (agentIO as unknown as { outputBuffer: Array<{ method: string; args: unknown[] }> })
          .outputBuffer;
        expect(buffer).toHaveLength(1);
        expect(buffer[0]).toEqual({ method: 'error', args: ['buffered error'] });
      });

      it('should buffer when line editor is active', () => {
        (agentIO as unknown as { activeLineEditor: unknown }).activeLineEditor = {
          handleKey: vi.fn(),
          close: vi.fn(),
        };

        agentIO.error('buffered error during prompt');

        expect(consoleErrorSpy).not.toHaveBeenCalled();
        const buffer = (agentIO as unknown as { outputBuffer: Array<{ method: string; args: unknown[] }> })
          .outputBuffer;
        expect(buffer).toHaveLength(1);
      });
    });

    describe('mixed output buffering', () => {
      it('should buffer log, warn, and error together', () => {
        agentIO.setNeglectedMode(true);

        agentIO.log('log message');
        agentIO.warn('warn message');
        agentIO.error('error message');

        const buffer = (agentIO as unknown as { outputBuffer: Array<{ method: string; args: unknown[] }> })
          .outputBuffer;
        expect(buffer).toHaveLength(3);
        expect(buffer[0]).toEqual({ method: 'log', args: ['log message'] });
        expect(buffer[1]).toEqual({ method: 'warn', args: ['warn message'] });
        expect(buffer[2]).toEqual({ method: 'error', args: ['error message'] });
      });
    });
  });

  describe('flushOutput', () => {
    it('should do nothing when buffer is empty', () => {
      agentIO.flushOutput();

      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });




    it('should flush mixed messages in order', () => {
      (agentIO as unknown as { outputBuffer: Array<{ method: string; args: unknown[] }> }).outputBuffer = [
        { method: 'log', args: ['log 1'] },
        { method: 'warn', args: ['warn 1'] },
        { method: 'error', args: ['error 1'] },
        { method: 'log', args: ['log 2'] },
      ];

      agentIO.flushOutput();

      expect(consoleLogSpy).toHaveBeenCalledTimes(2);
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);

      // Check order
      expect(consoleLogSpy).toHaveBeenNthCalledWith(1, 'log 1');
      expect(consoleWarnSpy).toHaveBeenNthCalledWith(1, 'warn 1');
      expect(consoleErrorSpy).toHaveBeenNthCalledWith(1, 'error 1');
      expect(consoleLogSpy).toHaveBeenNthCalledWith(2, 'log 2');
    });





    it('should not interfere with new buffering after flush', () => {
      // First round
      agentIO.setNeglectedMode(true);
      agentIO.log('first message');
      agentIO.flushOutput();

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);

      // Second round
      agentIO.log('second message');
      agentIO.flushOutput();

      expect(consoleLogSpy).toHaveBeenCalledTimes(2);
    });
  });

});
