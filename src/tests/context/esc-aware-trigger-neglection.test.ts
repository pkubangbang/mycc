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
import { describe, test, beforeEach, afterEach } from 'vitest';
import { expect } from 'chai';
import { Core } from '../../context/parent/core.js';
import { agentIO } from '../../loop/agent-io.js';
import type { AgentContext } from '../../types.js';

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
