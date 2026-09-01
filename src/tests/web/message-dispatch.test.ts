/**
 * message-dispatch.test.ts - L2 unit tests for the DOM-free message dispatch
 *
 * `applyServerMessage` is the single chokepoint for frontend state transitions.
 * Because it only consumes the reactive `state` object and an injected
 * `DispatchContext` (nextId/chatApi), it can be tested directly in the node
 * environment with zero DOM/browser dependencies — no jsdom, no Playwright.
 */
import { describe, it, expect, vi } from 'vitest';
import { reactive } from 'vue';
import { applyServerMessage } from '../../web/src/message-dispatch.js';
import type { ChatState, ChatMessage } from '../../web/src/types.js';

function makeState(): ChatState {
  return reactive<ChatState>({
    messages: [],
    inputText: '',
    isWaiting: false,
    isRunning: false,
    isAutoMode: false,
    connectionStatus: 'disconnected',
    showRetry: false,
    hasPendingCard: false,
    verboseLogs: false,
    steeringBuffer: [],
    pendingSteeringReview: [],
    pendingFiles: [],
    teammateMessages: [],
    darkMode: false,
    debugMode: false,
  });
}

function makeCtx(overrides: { sendInput?: (text: string) => void } = {}) {
  let id = 0;
  return {
    nextId: () => ++id,
    chatApi: {
      sendInput: overrides.sendInput ?? vi.fn(),
    },
  };
}

function steerEcho(content: string, steerId: number): ChatMessage {
  return { type: 'steer-echo', content, steerId };
}

describe('applyServerMessage — steering review card', () => {
  it('moves pending steering notes into review at prompt (non-auto)', () => {
    const state = makeState();
    const ctx = makeCtx();
    applyServerMessage(state, steerEcho('note A', 1), ctx);
    applyServerMessage(state, steerEcho('note B', 2), ctx);
    expect(state.steeringBuffer.map((n) => n.id)).toEqual([1, 2]);
    expect(state.pendingSteeringReview).toEqual([]);

    applyServerMessage(state, { type: 'prompt', content: '' }, ctx);
    expect(state.steeringBuffer).toEqual([]);
    expect(state.pendingSteeringReview.map((n) => n.id)).toEqual([1, 2]);
    expect(state.isWaiting).toBe(true);
  });

  it('does NOT surface review card in auto mode', () => {
    const state = makeState();
    state.isAutoMode = true;
    const ctx = makeCtx();
    applyServerMessage(state, steerEcho('note A', 1), ctx);
    applyServerMessage(state, { type: 'prompt', content: '' }, ctx);
    expect(state.steeringBuffer).toEqual([]);
    expect(state.pendingSteeringReview).toEqual([]);
  });

  it('steer-flush clears only the buffer, never populates review', () => {
    const state = makeState();
    const ctx = makeCtx();
    applyServerMessage(state, steerEcho('consumed', 1), ctx);
    applyServerMessage(state, { type: 'steer-flush', content: '' }, ctx);
    expect(state.steeringBuffer).toEqual([]);
    expect(state.pendingSteeringReview).toEqual([]);
    expect(state.isWaiting).toBe(false);
  });

  it('steer-echo with missing id falls back to nextId', () => {
    const state = makeState();
    const ctx = makeCtx();
    applyServerMessage(state, { type: 'steer-echo', content: 'no-id' }, ctx);
    expect(state.steeringBuffer[0].id).toBe(1);
    expect(state.steeringBuffer[0].text).toBe('no-id');
  });

  it('auto:on abandons any pending review', () => {
    const state = makeState();
    const ctx = makeCtx();
    applyServerMessage(state, steerEcho('note A', 1), ctx);
    applyServerMessage(state, { type: 'prompt', content: '' }, ctx);
    expect(state.pendingSteeringReview).toHaveLength(1);
    applyServerMessage(state, { type: 'auto', content: 'on' }, ctx);
    expect(state.isAutoMode).toBe(true);
    expect(state.pendingSteeringReview).toEqual([]);
  });
});

describe('applyServerMessage — other transitions', () => {
  it('running:on/off flips isRunning', () => {
    const state = makeState();
    const ctx = makeCtx();
    applyServerMessage(state, { type: 'running', content: 'on' }, ctx);
    expect(state.isRunning).toBe(true);
    applyServerMessage(state, { type: 'running', content: 'off' }, ctx);
    expect(state.isRunning).toBe(false);
  });

  it('card message sets hasPendingCard and isWaiting', () => {
    const state = makeState();
    const ctx = makeCtx();
    applyServerMessage(
      state,
      { type: 'card', content: 'Confirm?', cardId: 'c1', kind: 'confirm' },
      ctx,
    );
    expect(state.isWaiting).toBe(true);
    expect(state.hasPendingCard).toBe(true);
    expect(state.messages.some((m) => m.type === 'card' && m.card?.cardId === 'c1')).toBe(true);
  });

  it('routes @-prefixed labels to teammateMessages', () => {
    const state = makeState();
    const ctx = makeCtx();
    applyServerMessage(state, { type: 'result', content: 'hi', label: '@bob/tool' }, ctx);
    expect(state.teammateMessages).toHaveLength(1);
    expect(state.messages).toHaveLength(0);
  });

  it('routes unlabelled non-control messages to messages', () => {
    const state = makeState();
    const ctx = makeCtx();
    applyServerMessage(state, { type: 'result', content: 'done' }, ctx);
    expect(state.messages).toHaveLength(1);
    expect(state.teammateMessages).toHaveLength(0);
  });

  it('retry prompt flips showRetry', () => {
    const state = makeState();
    const ctx = makeCtx();
    applyServerMessage(state, { type: 'prompt', content: 'Retry? [Y/n]' }, ctx);
    expect(state.showRetry).toBe(true);
    expect(state.isWaiting).toBe(true);
  });
});

describe('applyServerMessage — lastServerMsg diagnostic recording', () => {
  it('records type+timestamp for explicitly handled messages', () => {
    const state = makeState();
    const ctx = makeCtx();
    applyServerMessage(state, { type: 'prompt', content: '' }, ctx);
    expect(state.lastServerMsg?.type).toBe('prompt');
    expect(typeof state.lastServerMsg?.at).toBe('number');

    applyServerMessage(state, { type: 'running', content: 'on' }, ctx);
    expect(state.lastServerMsg?.type).toBe('running');
  });

  it('records messages that fall through the default branch too', () => {
    const state = makeState();
    const ctx = makeCtx();
    // 'result' with no label is not explicitly branched — it hits the default
    // fall-through (the isWaiting flipper under investigation).
    applyServerMessage(state, { type: 'result', content: 'wrap-up summary' }, ctx);
    expect(state.lastServerMsg?.type).toBe('result');
    expect(state.isWaiting).toBe(false); // default branch flipped it
  });

  it('keeps recording on every subsequent message (latest wins)', () => {
    const state = makeState();
    const ctx = makeCtx();
    applyServerMessage(state, { type: 'prompt', content: '' }, ctx);
    applyServerMessage(state, steerEcho('note', 1), ctx);
    expect(state.lastServerMsg?.type).toBe('steer-echo');
  });

  it('replaces the previous record instead of accumulating', () => {
    const state = makeState();
    const ctx = makeCtx();
    applyServerMessage(state, { type: 'prompt', content: '' }, ctx);
    const first = { ...state.lastServerMsg! };
    applyServerMessage(state, { type: 'auto', content: 'off' }, ctx);
    expect(state.lastServerMsg!.type).not.toBe(first.type);
    expect(state.lastServerMsg!.at).toBeGreaterThanOrEqual(first.at);
  });
});
