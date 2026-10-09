/**
 * esc-aware-trigger-neglection.test.ts
 *
 * Reproduces the exact abort path the WebUI 停止 (stop) button triggers:
 *   WS 'interrupt' → agentIO.triggerNeglection() → escAware's onNeglectedHandler
 *   → abortController.abort() + onCleanUp() → escResolver(result).
 *
 * The existing esc-aware.test.ts manually iterates `(agentIO as any)
 * .onNeglectedCallbacks` to simulate ESC. That bypasses the REAL
 * `triggerNeglection()` method — the exact entry point the 停止 button uses
 * (serve-ws-handler.ts 'interrupt' case). This test drives the real
 * `triggerNeglection()` to verify the escAware promise actually resolves
 * (i.e. the hint-round abort does NOT hang the loop).
 *
 * Regression target: auto mode + webui on + hint round running + click 停止
 * → the loop must NOT hang; escAware must resolve with the cleanup result so
 * handleCollect returns STOP → PROMPT.
 */
import { describe, test, beforeEach, afterEach, vi } from 'vitest';
import { expect } from 'chai';
import { Core } from '../../context/parent/core.js';
import { agentIO } from '../../loop/agent-io.js';
import type { AgentContext } from '../../types.js';

// --- Module mocks for the SERVE-path tests ----------------------------------
//
// esc-wrap-up.ts imports three modules that are heavy or process-bound in a
// unit test: chat-provider (retryChat → live LLM call), config (getApiProvider
// reads env), and serve-registry (getServeHub → ServeHub.getInstance(), which
// would report a real server that is NOT running in vitest). We stub all three
// so the SERVE wrap-up delivery path can be exercised deterministically.
//
// `serveRunning` is a module-level toggle flipped per-test so one describe
// block can prove BOTH the serve branch fires (true) AND that the terminal
// branch falls back to the editor path (false), against the SAME code.

let serveRunning = false;

vi.mock('../../engine/chat-provider.js', () => ({
  // resolve to a chat-like response; per-test the content can be overridden
  // by re-mocking retryChat if needed, but the default is a simple wrap-up.
  retryChat: vi.fn(async () => ({ message: { content: 'Wrap-up complete. Awaiting next step.' } })),
  MODEL: 'test-model',
}));

vi.mock('../../config.js', async (importOriginal) => {
  // Spread the REAL config exports (getImgCacheDir, ensureDirs, getLongtextDir,
  // ...) so modules that Core/esc-wrap-up pull in transitively still resolve,
  // then override ONLY getApiProvider so runWrapUpLLM takes the Ollama branch
  // (no toolChoice) deterministically. A narrow mock here broke the 3
  // pre-existing tests that construct `new Core('/tmp')` — Core's constructor
  // calls getImgCacheDir(), which the narrow mock did not export.
  const actual = await importOriginal<typeof import('../../config.js')>();
  return {
    ...actual,
    getApiProvider: () => 'ollama',
  };
});

vi.mock('../../serve/serve-registry.js', () => {
  // Minimal ServeHub stub: `isRunning` is the only stateful member esc-wrap-up
  // and the neglection path consult; the other methods agentIO.initMain() and
  // the existing tests touch (setAutoStateProvider, isInputBlocked,
  // gracefulShutdown) are stubbed as no-ops so `new Core()` → initMain() does
  // not crash. `onWrapUpSettled` is the A1 wake seam — called in esc-wrap-up's
  // promise settle paths (gated on isRunning()); the stub records nothing (the
  // steering queue is manager-owned and irrelevant here). The real
  // ServeHub.getInstance() would try to bind a server port, so we do NOT
  // importOriginal here — a hand-rolled stub is safer and keeps the test
  // hermetic.
  const hub = {
    isRunning: () => serveRunning,
    setAutoStateProvider: () => {},
    isInputBlocked: () => false,
    gracefulShutdown: () => Promise.resolve(),
    onWrapUpSettled: () => {},
  };
  return { getServeHub: () => hub };
});

// Imports AFTER mocks so esc-wrap-up picks up the stubbed dependencies.
// (startWrapUp/tryDisplayWrapUp = orchestration, stays on esc-wrap-up;
// hasPendingWrapUp/clearWrapUp = state, moved to wrap-up-state per A5.)
import { startWrapUp, tryDisplayWrapUp } from '../../loop/esc-wrap-up.js';
import {
  hasPendingWrapUp,
  clearWrapUp,
  getWrapUpState,
} from '../../loop/wrap-up-state.js';
import { setResultCallback } from '../../utils/letter-box.js';
import type { Triologue } from '../../loop/triologue.js';

describe('escAware + real triggerNeglection (WebUI 停止 path)', () => {
  let ctx: AgentContext;

  beforeEach(() => {
    const core = new Core('/tmp');
    ctx = {
      core,
      todo: {} as never,
      mail: {} as never,
      skill: {} as never,
      issue: {} as never,
      bg: {} as never,
      team: {} as never,
      wiki: {} as never,
      peer: {} as never,
    };
    agentIO.initMain();
  });

  afterEach(() => {
    agentIO.setNeglectedMode(false);
    // Clear any registered callbacks so they don't leak across tests.
    (agentIO as unknown as { onNeglectedCallbacks: Set<() => void> }).onNeglectedCallbacks = new Set();
  });

  test('triggerNeglection resolves escAware with the cleanup result (no hang)', async () => {
    let operationCompleted = false;
    let abortSignalAborted = false;

    // Start the escAware operation (simulates the hint round running).
    const resultPromise = ctx.core.escAware(
      async (abortController) => {
        abortController.signal.addEventListener('abort', () => {
          abortSignalAborted = true;
        });
        // Simulate a slow hint-round LLM call that never completes on its own.
        await new Promise((resolve) => setTimeout(resolve, 500));
        operationCompleted = true;
        return 'operation-result';
      },
      () => 'aborted' as const,
    );

    // Give escAware a tick to register its onNeglectedHandler.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Simulate the WebUI 停止 button: WS 'interrupt' → triggerNeglection().
    agentIO.triggerNeglection();

    // The escAware promise MUST resolve with the cleanup result ('aborted'),
    // NOT hang. Race against a timeout to prove it resolves promptly.
    const result = await Promise.race([
      resultPromise,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2000)),
    ]);

    expect(result).to.equal('aborted');
    // The abort controller must have been aborted (LLM call cancelled).
    expect(abortSignalAborted).to.be.true;
    // The operation must NOT have completed (we returned early).
    expect(operationCompleted).to.be.false;
    // Neglected mode is set (STOP state will clear it).
    expect(agentIO.isNeglectedMode()).to.be.true;
  });

  test('triggerNeglection is idempotent (double 停止 click does not double-fire)', async () => {
    let cleanupCalls = 0;

    const resultPromise = ctx.core.escAware(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return 'operation-result';
      },
      () => {
        cleanupCalls++;
        return 'aborted' as const;
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    // Double-click 停止.
    agentIO.triggerNeglection();
    agentIO.triggerNeglection();

    const result = await Promise.race([
      resultPromise,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2000)),
    ]);

    expect(result).to.equal('aborted');
    // The second triggerNeglection is a no-op (already neglected) — cleanup
    // runs exactly once.
    expect(cleanupCalls).to.equal(1);
  });

  test('triggerNeglection aborts the registered LLM abort controller', async () => {
    // Simulate the LLM stage registering its abort controller (llm.ts sets
    // chat.abortController via setLlmAbortController).
    const llmController = new AbortController();
    (agentIO as unknown as { llmAbortController: AbortController | null }).llmAbortController = llmController;

    agentIO.triggerNeglection();

    expect(llmController.signal.aborted).to.be.true;
  });
});

// ============================================================================
// SERVE (WebUI) wrap-up delivery — the 停止/Stop-button hang regression.
//
// Root cause: WebUI 停止 → triggerNeglection
// → neglection wrap-up is silently dropped in SERVE mode because the call sites
// of tryDisplayWrapUp (agent-io.ts:893/1017) are inside terminal ask() blocks
// that serve mode never enters (web-input-provider routes to
// hub.waitForInput()), AND the old tryDisplayWrapUp hard-gated on a non-null
// LineEditor — null in serve. So the wrap-up the background LLM produced was
// never broadcast, and the WebUI chat froze after the last bubble.
//
// Fix under test: (1) a SERVE branch in tryDisplayWrapUp that calls
// displayLetterBox directly when getServeHub().isRunning() (no editor needed),
// and (2) a completion trigger inside startWrapUp's promise.then that delivers
// the moment the background LLM finishes (the robust site, since the terminal
// call sites are unreachable in serve). displayLetterBox mirrors its stripped
// content to the WebUI via the resultCallback (set by activate.ts), so we
// assert on that callback as the broadcast observable.
// ============================================================================

/**
 * Build a minimal Triologue stub that satisfies what startWrapUp/runWrapUpLLM
 * touch: beginWrapUp (mark + add user msg), getMessages (returns the LLM
 * context), finishWrapUp (add agent msg — a no-op when wrapUpMark===-1, which
 * we exercise via the early-resolve path). Casting to the Triologue type keeps
 * the test isolated from the real constructor's onMessage/onMisorder wiring.
 */
function makeStubTriologue(): Triologue {
  const messages: { role: string; content: string }[] = [
    { role: 'user', content: 'do something' },
    { role: 'assistant', content: 'working on it' },
  ];
  let wrapActive = false;
  return {
    beginWrapUp: () => {
      if (wrapActive) return;
      wrapActive = true;
      messages.push({ role: 'user', content: '[WRAP_UP] interrupted' });
    },
    getMessages: () => messages as never,
    finishWrapUp: (content: string) => {
      if (!wrapActive) return;
      messages.push({ role: 'assistant', content });
      // mark stays for rollback; not reset here.
    },
  } as unknown as Triologue;
}

describe('SERVE wrap-up delivery (WebUI 停止 hang regression)', () => {
  let broadcasted: string[];
  // displayLetterBox writes to stdout; suppress the box noise during tests.
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    serveRunning = true;
    broadcasted = [];
    setResultCallback((content: string) => {
      broadcasted.push(content);
    });
    // Stub stdout.write so the letter-box banner does not spam the test log.
    stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    clearWrapUp();
  });

  afterEach(() => {
    setResultCallback(null);
    serveRunning = false;
    stdoutWriteSpy.mockRestore();
    clearWrapUp();
  });

  test('Case A: running hub + pending wrap-up → tryDisplayWrapUp(null) broadcasts via displayLetterBox and marks shown', async () => {
    // Set up the pending wrap-up with the hub NOT running so startWrapUp's
    // completion trigger (the robust site added for Case B) is a NO-OP — it
    // checks getServeHub().isRunning() at completion time and finds false, so
    // shown stays false and displayLetterBox is NOT called by the completion
    // path. This isolates tryDisplayWrapUp(null) as the SOLE delivery site
    // under test. (The genuine gap the belt-and-suspenders call exists for:
    // serve was not running when the wrap-up completed, but IS running by the
    // time the next prompt cycle calls tryDisplayWrapUp(null).)
    serveRunning = false;
    const triologue = makeStubTriologue();
    startWrapUp(triologue);
    const state = getWrapUpState();
    await state.promise;
    // Give the completion .then microtask a tick — with serveRunning=false it
    // must NOT have delivered or marked shown.
    await new Promise((resolve) => setImmediate(resolve));

    // Sanity: the wrap-up completed with content and is NOT yet shown (the
    // completion trigger skipped because the hub was not running).
    expect(state.content).to.not.be.null;
    expect(state.shown).to.be.false;
    expect(hasPendingWrapUp()).to.be.true;
    expect(broadcasted).to.have.lengthOf(0);

    // Now the WebUI comes up (or serve was toggled on between completion and
    // the prompt cycle). Flip the hub to running BEFORE the
    // belt-and-suspenders call web-input-provider makes after broadcasting the
    // prompt: tryDisplayWrapUp(null) with NO editor. With serve running this
    // must hit the SERVE branch (displayLetterBox) rather than bail on null.
    serveRunning = true;
    const shown = tryDisplayWrapUp(null);

    expect(shown).to.be.true;
    // displayLetterBox stripped the content and mirrored it through the
    // resultCallback → this is the WebUI broadcast observable.
    expect(broadcasted).to.have.lengthOf(1);
    expect(broadcasted[0]).to.include('Wrap-up complete');
    // markWrapUpShown ran — no longer pending.
    expect(hasPendingWrapUp()).to.be.false;
  });

  test('Case B: startWrapUp() completion with a running hub delivers via displayLetterBox WITHOUT any ask()/LineEditor', async () => {
    const triologue = makeStubTriologue();
    startWrapUp(triologue);

    // The completion trigger lives in startWrapUp's promise.then. Wait for the
    // background LLM (mocked retryChat resolves immediately) to finish — at
    // that point the SERVE branch in the completion handler fires
    // displayLetterBox on its own, with NO ask()/LineEditor in scope. This is
    // the robust site: it does not depend on a later prompt-cycle call.
    const state = getWrapUpState();
    await state.promise;
    // Give the .then microtask a tick to run displayLetterBox.
    await new Promise((resolve) => setImmediate(resolve));

    expect(broadcasted).to.have.lengthOf(1);
    expect(broadcasted[0]).to.include('Wrap-up complete');
    // The completion handler calls markWrapUpShown, so a later
    // tryDisplayWrapUp(null) is a no-op — proves double-display is impossible.
    expect(hasPendingWrapUp()).to.be.false;
    const secondShown = tryDisplayWrapUp(null);
    expect(secondShown).to.be.false;
    expect(broadcasted).to.have.lengthOf(1);
  });

  test('Case C (negative control): hub NOT running → tryDisplayWrapUp(null) does NOT broadcast (terminal fallback preserved)', async () => {
    serveRunning = false;
    const triologue = makeStubTriologue();
    startWrapUp(triologue);
    const state = getWrapUpState();
    await state.promise;
    // Give the .then microtask a tick — with serveRunning=false, the
    // completion handler does NOT call displayLetterBox (terminal path owns
    // delivery via the editor).
    await new Promise((resolve) => setImmediate(resolve));

    expect(broadcasted).to.have.lengthOf(0);
    // Wrap-up is still pending (not shown) because there is no editor and no
    // serve hub to deliver through — this is the historical terminal-mode
    // behavior, preserved.
    expect(hasPendingWrapUp()).to.be.true;
    // tryDisplayWrapUp(null) with no editor AND no running hub must bail
    // (return false) rather than broadcast — the terminal branch still
    // requires a LineEditor.
    const shown = tryDisplayWrapUp(null);
    expect(shown).to.be.false;
    expect(broadcasted).to.have.lengthOf(0);
  });
});
