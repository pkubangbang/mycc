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

// `process.emit('message', ...)` is how the Coordinator delivers IPC to the
// agent process, but Node's typed EventEmitter overload does not list
// `'message'` (it is an untyped IPC channel). Emit through a loosely-typed
// view so the test drives the same code path agent-io.ts consumes. `message`
// and `MessageEvent` are not in the default lib, so we declare the payload
// shape inline.
type IpcMessage = { type: string; [key: string]: unknown };
const ipcEmitter = process as unknown as {
  emit(event: 'message', message: IpcMessage): boolean;
  listeners(event: 'message'): Array<(message: IpcMessage) => void>;
  off(event: 'message', listener: (message: IpcMessage) => void): unknown;
};

function emitIpc(message: IpcMessage): void {
  ipcEmitter.emit('message', message);
}

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
    const messageListenersBefore = ipcEmitter.listeners('message');

    try {
      agentIO.initMain();
      emitIpc({ type: 'neglection' });
      emitIpc({ type: 'neglection' });

      expect(hub.gracefulShutdown).toHaveBeenCalledTimes(1);
      expect(agentIO.isNeglectedMode()).toBe(false);
      expect(abort).not.toHaveBeenCalled();

      finishShutdown();
      await shutdownPromise;
      await new Promise<void>((resolve) => setImmediate(resolve));

      // Once shutdown has settled, a later ESC retains its intended meaning.
      emitIpc({ type: 'neglection' });
      expect(agentIO.isNeglectedMode()).toBe(true);
      expect(abort).toHaveBeenCalledTimes(1);
    } finally {
      finishShutdown();
      for (const listener of ipcEmitter.listeners('message')) {
        if (!messageListenersBefore.includes(listener)) {
          ipcEmitter.off('message', listener);
        }
      }
    }
  });
});
