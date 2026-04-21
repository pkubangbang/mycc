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
    (agentIO as unknown as { onNeglectedCallbacks: Array<() => void> }).onNeglectedCallbacks = [];

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

      it('should handle multiple arguments', () => {
        agentIO.log('arg1', 'arg2', 'arg3');

        expect(consoleLogSpy).toHaveBeenCalledWith('arg1', 'arg2', 'arg3');
      });

      it('should buffer multiple calls in interaction mode', () => {
        agentIO.setNeglectedMode(true);

        agentIO.log('message 1');
        agentIO.log('message 2');
        agentIO.log('message 3');

        const buffer = (agentIO as unknown as { outputBuffer: Array<{ method: string; args: unknown[] }> })
          .outputBuffer;
        expect(buffer).toHaveLength(3);
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

    it('should flush log messages', () => {
      // Manually add to buffer
      (agentIO as unknown as { outputBuffer: Array<{ method: string; args: unknown[] }> }).outputBuffer = [
        { method: 'log', args: ['message 1'] },
        { method: 'log', args: ['message 2'] },
      ];

      agentIO.flushOutput();

      expect(consoleLogSpy).toHaveBeenCalledTimes(2);
      expect(consoleLogSpy).toHaveBeenNthCalledWith(1, 'message 1');
      expect(consoleLogSpy).toHaveBeenNthCalledWith(2, 'message 2');
    });

    it('should flush warn messages', () => {
      (agentIO as unknown as { outputBuffer: Array<{ method: string; args: unknown[] }> }).outputBuffer = [
        { method: 'warn', args: ['warning 1'] },
        { method: 'warn', args: ['warning 2'] },
      ];

      agentIO.flushOutput();

      expect(consoleWarnSpy).toHaveBeenCalledTimes(2);
      expect(consoleWarnSpy).toHaveBeenNthCalledWith(1, 'warning 1');
      expect(consoleWarnSpy).toHaveBeenNthCalledWith(2, 'warning 2');
    });

    it('should flush error messages', () => {
      (agentIO as unknown as { outputBuffer: Array<{ method: string; args: unknown[] }> }).outputBuffer = [
        { method: 'error', args: ['error 1'] },
        { method: 'error', args: ['error 2'] },
      ];

      agentIO.flushOutput();

      expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
      expect(consoleErrorSpy).toHaveBeenNthCalledWith(1, 'error 1');
      expect(consoleErrorSpy).toHaveBeenNthCalledWith(2, 'error 2');
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

    it('should clear buffer after flush', () => {
      (agentIO as unknown as { outputBuffer: Array<{ method: string; args: unknown[] }> }).outputBuffer = [
        { method: 'log', args: ['message'] },
      ];

      agentIO.flushOutput();

      const buffer = (agentIO as unknown as { outputBuffer: Array<{ method: string; args: unknown[] }> })
        .outputBuffer;
      expect(buffer).toHaveLength(0);
    });

    it('should handle messages with multiple arguments', () => {
      (agentIO as unknown as { outputBuffer: Array<{ method: string; args: unknown[] }> }).outputBuffer = [
        { method: 'log', args: ['arg1', 'arg2', 'arg3'] },
      ];

      agentIO.flushOutput();

      expect(consoleLogSpy).toHaveBeenCalledWith('arg1', 'arg2', 'arg3');
    });

    it('should handle empty arguments array', () => {
      (agentIO as unknown as { outputBuffer: Array<{ method: string; args: unknown[] }> }).outputBuffer = [
        { method: 'log', args: [] },
      ];

      agentIO.flushOutput();

      expect(consoleLogSpy).toHaveBeenCalledWith();
    });

    it('should handle large buffer', () => {
      const largeBuffer: Array<{ method: 'log' | 'warn' | 'error'; args: unknown[] }> = [];
      for (let i = 0; i < 100; i++) {
        largeBuffer.push({ method: 'log', args: [`message ${i}`] });
      }
      (agentIO as unknown as { outputBuffer: Array<{ method: string; args: unknown[] }> }).outputBuffer =
        largeBuffer;

      agentIO.flushOutput();

      expect(consoleLogSpy).toHaveBeenCalledTimes(100);
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

  describe('Edge Cases', () => {
    it('should handle concurrent log calls safely', () => {
      agentIO.setNeglectedMode(true);

      // Simulate concurrent calls
      for (let i = 0; i < 10; i++) {
        agentIO.log(`concurrent message ${i}`);
      }

      const buffer = (agentIO as unknown as { outputBuffer: Array<{ method: string; args: unknown[] }> })
        .outputBuffer;
      expect(buffer).toHaveLength(10);
    });

    it('should handle state transitions during buffering', () => {
      // Start not in interaction mode
      agentIO.log('direct message 1');
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);

      // Enter interaction mode
      agentIO.setNeglectedMode(true);
      agentIO.log('buffered message');
      expect(consoleLogSpy).toHaveBeenCalledTimes(1); // No new calls

      // Exit interaction mode and flush
      agentIO.setNeglectedMode(false);
      agentIO.flushOutput();
      expect(consoleLogSpy).toHaveBeenCalledTimes(2);

      // Now log directly again
      agentIO.log('direct message 2');
      expect(consoleLogSpy).toHaveBeenCalledTimes(3);
    });

    it('should handle objects and complex arguments', () => {
      const obj = { key: 'value', nested: { a: 1 } };
      const arr = [1, 2, 3];

      agentIO.setNeglectedMode(true);
      agentIO.log('object:', obj, 'array:', arr);

      const buffer = (agentIO as unknown as { outputBuffer: Array<{ method: string; args: unknown[] }> })
        .outputBuffer;
      expect(buffer[0].args).toEqual(['object:', obj, 'array:', arr]);

      agentIO.flushOutput();
      expect(consoleLogSpy).toHaveBeenCalledWith('object:', obj, 'array:', arr);
    });

    it('should handle special string values', () => {
      agentIO.setNeglectedMode(true);
      agentIO.log('');
      agentIO.log('   ');
      agentIO.log('\n\t');
      agentIO.log('unicode: \u{1F600}');

      agentIO.flushOutput();

      expect(consoleLogSpy).toHaveBeenCalledTimes(4);
    });

    it('should handle null and undefined arguments', () => {
      agentIO.setNeglectedMode(true);
      agentIO.log(null);
      agentIO.log(undefined);
      agentIO.log('mixed', null, undefined);

      agentIO.flushOutput();

      expect(consoleLogSpy).toHaveBeenCalledWith(null);
      expect(consoleLogSpy).toHaveBeenCalledWith(undefined);
      expect(consoleLogSpy).toHaveBeenCalledWith('mixed', null, undefined);
    });

    it('should handle numeric arguments', () => {
      agentIO.setNeglectedMode(true);
      agentIO.log(42);
      agentIO.log(3.14159);
      agentIO.log(-1);
      agentIO.log(0);
      agentIO.log(Infinity);
      agentIO.log(NaN);

      agentIO.flushOutput();

      expect(consoleLogSpy).toHaveBeenCalledTimes(6);
    });

    it('should maintain separate buffers for different output methods', () => {
      agentIO.setNeglectedMode(true);

      agentIO.log('log message');
      agentIO.warn('warn message');
      agentIO.error('error message');
      agentIO.log('another log');

      const buffer = (agentIO as unknown as { outputBuffer: Array<{ method: string; args: unknown[] }> })
        .outputBuffer;

      expect(buffer).toEqual([
        { method: 'log', args: ['log message'] },
        { method: 'warn', args: ['warn message'] },
        { method: 'error', args: ['error message'] },
        { method: 'log', args: ['another log'] },
      ]);
    });
  });
});