/**
 * esc-aware.test.ts - Unit tests for escAware functionality
 */

import { describe, test, beforeEach, afterEach } from 'vitest';
import { expect } from 'chai';
import { Core } from '../../context/parent/core.js';
import { agentIO } from '../../loop/agent-io.js';
import type { AgentContext } from '../../types.js';

describe('escAware', () => {
  let ctx: AgentContext;

  beforeEach(() => {
    // Create a minimal context with Core
    const core = new Core('/tmp');
    ctx = {
      core,
      todo: {} as any,
      mail: {} as any,
      skill: {} as any,
      issue: {} as any,
      bg: {} as any,
      wt: {} as any,
      team: {} as any,
      wiki: {} as any,
    };

    // Initialize agentIO for main process
    agentIO.initMain();
  });

  afterEach(() => {
    // Reset neglected mode after each test
    agentIO.setNeglectedMode(false);
  });

  test('should return operation result when ESC is not pressed', async () => {
    const result = await ctx.core.escAware(
      async (abortController) => {
        // Verify abort controller is provided
        expect(abortController).toBeDefined();
        expect(abortController.signal).toBeDefined();
        // Simulate a slow operation that completes
        await new Promise(resolve => setTimeout(resolve, 100));
        return 'operation-result';
      },
      () => 'cleanup-result'
    );

    expect(result).to.equal('operation-result');
  });

  test('should return cleanup result when ESC is already pressed', async () => {
    // Simulate ESC already pressed
    agentIO.setNeglectedMode(true);

    const result = await ctx.core.escAware(
      async (_abortController) => {
        // This should not be called
        await new Promise(resolve => setTimeout(resolve, 100));
        return 'operation-result';
      },
      () => 'cleanup-result'
    );

    expect(result).to.equal('cleanup-result');
  });

  test('should return cleanup result when ESC is pressed during operation', async () => {
    let operationCompleted = false;
    let abortControllerReceived: AbortController | null = null;

    const resultPromise = ctx.core.escAware(
      async (abortController) => {
        abortControllerReceived = abortController;
        // Simulate a slow operation
        await new Promise(resolve => setTimeout(resolve, 500));
        operationCompleted = true;
        return 'operation-result';
      },
      () => 'cleanup-result'
    );

    // Simulate ESC press after a short delay
    // This triggers the neglected callbacks registered by escAware
    setTimeout(() => {
      agentIO.setNeglectedMode(true);
      // Manually trigger the neglected callbacks
      // In real code, this is done by the Coordinator IPC message
      const callbacks = (agentIO as any).onNeglectedCallbacks;
      for (const cb of callbacks) {
        cb();
      }
    }, 50);

    const result = await resultPromise;

    // Should return cleanup result, not operation result
    expect(result).to.equal('cleanup-result');
    
    // AbortController should have been provided
    expect(abortControllerReceived).toBeDefined();
    
    // Operation should NOT have completed (we returned early)
    expect(operationCompleted).to.be.false;
  });

  test('should support async cleanup function', async () => {
    agentIO.setNeglectedMode(true);

    const result = await ctx.core.escAware(
      async (_abortController) => 'operation-result',
      async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return 'async-cleanup-result';
      }
    );

    expect(result).to.equal('async-cleanup-result');
  });

  test('should work with complex return types', async () => {
    interface ComplexResult {
      status: string;
      data: number[];
    }

    const result = await ctx.core.escAware<ComplexResult>(
      async (_abortController) => ({
        status: 'success',
        data: [1, 2, 3],
      }),
      () => ({
        status: 'interrupted',
        data: [],
      })
    );

    expect(result.status).to.equal('success');
    expect(result.data).to.deep.equal([1, 2, 3]);
  });

  test('should abort the controller when ESC is pressed', async () => {
    let abortSignalAborted = false;

    const resultPromise = ctx.core.escAware(
      async (abortController) => {
        // Track if signal gets aborted
        abortController.signal.addEventListener('abort', () => {
          abortSignalAborted = true;
        });
        // Simulate a slow operation
        await new Promise(resolve => setTimeout(resolve, 500));
        return 'operation-result';
      },
      () => 'cleanup-result'
    );

    // Simulate ESC press
    setTimeout(() => {
      agentIO.setNeglectedMode(true);
      const callbacks = (agentIO as any).onNeglectedCallbacks;
      for (const cb of callbacks) {
        cb();
      }
    }, 50);

    const result = await resultPromise;

    // Should return cleanup result
    expect(result).to.equal('cleanup-result');
    
    // Abort controller should have been triggered
    expect(abortSignalAborted).to.be.true;
  });
});