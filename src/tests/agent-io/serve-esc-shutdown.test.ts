import { afterEach, describe, expect, it, vi } from 'vitest';

const { tryGetServeHub, onServeHubReady } = vi.hoisted(() => ({
  tryGetServeHub: vi.fn(),
  onServeHubReady: vi.fn(),
}));

vi.mock('../../serve/serve-registry.js', () => ({
  tryGetServeHub,
  onServeHubReady,
}));

import { agentIO } from '../../loop/agent-io.js';
import { tryGetServeHub } from '../../serve/serve-registry.js';

afterEach(() => {
  vi.restoreAllMocks();
  tryGetServeHub.mockReset();
  onServeHubReady.mockReset();
  const state = agentIO as unknown as {
    serveEscShutdownInProgress: boolean;
    neglectedModeFlag: boolean;
    activeLineEditor: unknown;
    llmAbortController: AbortController | null;
  };
  state.serveEscShutdownInProgress = false;
  state.neglectedModeFlag = false;
  state.activeLineEditor = null;
  state.llmAbortController = null;
});

describe('agentIO serve-mode ESC shutdown', () => {
  it('ignores a second ESC while graceful shutdown is pending even after isRunning flips false', async () => {
    let finishShutdown!: () => void;
    const shutdownPromise = new Promise<void>((resolve) => { finishShutdown = resolve; });
    const hub = {
      isRunning: vi.fn().mockReturnValueOnce(true).mockReturnValue(false),
      gracefulShutdown: vi.fn(() => shutdownPromise),
      setAutoStateProvider: vi.fn(),
    };
    vi.mocked(tryGetServeHub).mockReturnValue(hub as never);

    const controller = new AbortController();
    (agentIO as unknown as { llmAbortController: AbortController | null }).llmAbortController = controller;
    const abort = vi.spyOn(controller, 'abort');
    const messageListenersBefore = process.listeners('message');

    try {
      agentIO.initMain();
      process.emit('message', { type: 'neglection' });
      process.emit('message', { type: 'neglection' });

      expect(hub.gracefulShutdown).toHaveBeenCalledTimes(1);
      expect(agentIO.isNeglectedMode()).toBe(false);
      expect(abort).not.toHaveBeenCalled();

      finishShutdown();
      await shutdownPromise;
      await new Promise<void>((resolve) => setImmediate(resolve));

      // Once shutdown has settled, a later ESC retains its intended meaning.
      process.emit('message', { type: 'neglection' });
      expect(agentIO.isNeglectedMode()).toBe(true);
      expect(abort).toHaveBeenCalledTimes(1);
    } finally {
      finishShutdown();
      for (const listener of process.listeners('message')) {
        if (!messageListenersBefore.includes(listener)) {
          process.off('message', listener as (...args: any[]) => void);
        }
      }
    }
  });
});
