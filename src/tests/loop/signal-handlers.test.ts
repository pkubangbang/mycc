import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentContext } from '../../types.js';

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  stopHub: vi.fn<() => Promise<void>>(),
}));

vi.mock('chalk', () => ({
  default: {
    red: (value: string) => value,
    gray: (value: string) => value,
    yellow: (value: string) => value,
  },
}));

vi.mock('../../loop/agent-io.js', () => ({
  agentIO: {
    verbose: vi.fn(),
    getLlmAbortController: vi.fn(() => null),
  },
}));

vi.mock('../../serve/serve-registry.js', () => ({
  tryGetServeHub: () => ({ stop: mocks.stopHub }),
}));

import { registerSignalHandlers } from '../../loop/signal-handlers.js';

// The four events registerSignalHandlers() subscribes to. `process.on`/`removeListener`
// overload on NodeJS.Signals for the two real signals, so keep the OS-signal names
// separate from the error-event names rather than a single union (which TS rejects
// as `Signals`).
const signalNames = ['SIGINT', 'SIGTERM'] as const;
const errorEventNames = ['uncaughtException', 'unhandledRejection'] as const;
const registeredEvents = [...signalNames, ...errorEventNames];
let baselineListeners: Map<string, Function[]>;

beforeEach(() => {
  mocks.events.length = 0;
  vi.clearAllMocks();
  baselineListeners = new Map(
    registeredEvents.map((name) => [name, process.listeners(name as NodeJS.Signals)]),
  );
});

afterEach(() => {
  for (const name of registeredEvents) {
    const baseline = baselineListeners.get(name) ?? [];
    for (const listener of process.listeners(name as NodeJS.Signals)) {
      if (!baseline.includes(listener)) {
        process.removeListener(name as NodeJS.Signals, listener as (...args: unknown[]) => void);
      }
    }
  }
  vi.restoreAllMocks();
});

describe('gracefulTeardown identity lifetime', () => {
  it('keeps peer identity registered until ServeHub teardown settles', async () => {
    let releaseHubStop!: () => void;
    mocks.stopHub.mockImplementation(() => {
      mocks.events.push('hub-stop-started');
      return new Promise<void>((resolve) => {
        releaseHubStop = () => {
          mocks.events.push('hub-stopped');
          resolve();
        };
      });
    });
    const ctx = {
      team: { dismissTeam: () => mocks.events.push('team-dismissed') },
      bg: { killAllRunning: async () => { mocks.events.push('bg-killed'); } },
      peer: { stop: () => { mocks.events.push('peer-stopped'); } },
    } as unknown as AgentContext;
    vi.spyOn(process, 'exit').mockImplementation((() => {
      mocks.events.push('process-exit');
      return undefined as never;
    }) as never);

    const gracefulTeardown = registerSignalHandlers(ctx, null);
    const pending = gracefulTeardown('test');

    await vi.waitFor(() => expect(mocks.events).toContain('hub-stop-started'));
    expect(mocks.events).not.toContain('peer-stopped');

    releaseHubStop();
    await pending;

    expect(mocks.events.indexOf('hub-stopped')).toBeLessThan(mocks.events.indexOf('peer-stopped'));
    expect(mocks.events.indexOf('peer-stopped')).toBeLessThan(mocks.events.indexOf('process-exit'));
  });
});
