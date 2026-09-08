/**
 * message-dispatch.test.ts - L2 unit tests for the DOM-free message dispatch
 *
 * `applyServerMessage` is the single chokepoint for frontend phase transitions.
 * It consumes a `DispatchState` (satisfied by the Pinia store, but typed as a
 * structural interface so it can be stubbed in node without an active Pinia)
 * and an injected `DispatchContext` (nextId/chatApi). Tested directly in the
 * node environment with zero DOM/browser dependencies — no jsdom, no Playwright.
 */
import { describe, it, expect, vi } from 'vitest';
import { reactive, ref, computed } from 'vue';
import { applyServerMessage } from '../../web/src/message-dispatch.js';
import type { DispatchState } from '../../web/src/message-dispatch.js';
import type { ChatMessage, SteeringNote, WebuiPhase } from '../../web/src/types.js';

/**
 * Build a stub `DispatchState` that mirrors the Pinia store's reactive
 * surface without requiring `setActivePinia(createPinia())`. The derived
 * getters (`isWaiting` / `isRunning` / `hasPendingCard`) are computeds over
 * `phase`, exactly as in the real store. `setPhase` / `setAutoMode` mutate
 * the reactive refs. This keeps the dispatch tests fast and isolated from
 * Pinia initialization while exercising the exact same transition logic.
 */
function makeState(): DispatchState & {
  isWaiting: boolean;
  isRunning: boolean;
  hasPendingCard: boolean;
  hasReview: boolean;
} {
  const phase = ref<WebuiPhase>('idle');
  const isAutoMode = ref(false);
  const steeringBuffer = reactive<SteeringNote[]>([]);
  const pendingSteeringReview = reactive<SteeringNote[]>([]);
  const messages = reactive<ChatMessage[]>([]);
  const teammateMessages = reactive<ChatMessage[]>([]);
  const showRetry = ref(false);
  const lastServerMsg = ref<{ type: string; at: number } | undefined>(undefined);

  const isWaiting = computed(() => phase.value === 'prompt' || phase.value === 'card');
  const isRunning = computed(() => phase.value === 'working' || phase.value === 'submitted');
  const hasPendingCard = computed(() => phase.value === 'card');
  const hasReview = computed(() => pendingSteeringReview.length > 0);

  function setPhase(newPhase: WebuiPhase): void {
    phase.value = newPhase;
  }
  function setAutoMode(value: boolean): void {
    isAutoMode.value = value;
    if (value) pendingSteeringReview.splice(0);
  }

  // Return a reactive proxy so .value refs are unwrapped on access (matching
  // how a Pinia store instance exposes its state). Using reactive() on an
  // object holding refs auto-unwraps them.
  return reactive({
    phase,
    isAutoMode,
    steeringBuffer,
    pendingSteeringReview,
    messages,
    teammateMessages,
    showRetry,
    lastServerMsg,
    isWaiting,
    isRunning,
    hasPendingCard,
    hasReview,
    setPhase,
    setAutoMode,
  }) as DispatchState & {
    isWaiting: boolean;
    isRunning: boolean;
    hasPendingCard: boolean;
    hasReview: boolean;
  };
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
    expect(state.phase).toBe('prompt');
    expect(state.isWaiting).toBe(true);
  });

  it('does NOT surface review card in auto mode', () => {
    const state = makeState();
    state.setAutoMode(true);
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

describe('applyServerMessage — phase transitions', () => {
  it('running:on/off transitions working → idle', () => {
    const state = makeState();
    const ctx = makeCtx();
    applyServerMessage(state, { type: 'running', content: 'on' }, ctx);
    expect(state.phase).toBe('working');
    expect(state.isRunning).toBe(true);
    applyServerMessage(state, { type: 'running', content: 'off' }, ctx);
    expect(state.phase).toBe('idle');
    expect(state.isRunning).toBe(false);
  });

  it('running:off is NO-OP from prompt (reconnect reordering guard)', () => {
    const state = makeState();
    const ctx = makeCtx();
    // Establish a stable prompt phase
    applyServerMessage(state, { type: 'prompt', content: '' }, ctx);
    expect(state.phase).toBe('prompt');
    // A late running:off (reconnect sends prompt BEFORE running:off) must NOT
    // clobber the prompt phase.
    applyServerMessage(state, { type: 'running', content: 'off' }, ctx);
    expect(state.phase).toBe('prompt');
    expect(state.isWaiting).toBe(true);
  });

  it('running:off is NO-OP from await', () => {
    const state = makeState();
    const ctx = makeCtx();
    applyServerMessage(state, { type: 'auto', content: 'on' }, ctx);
    expect(state.phase).toBe('await');
    applyServerMessage(state, { type: 'running', content: 'off' }, ctx);
    expect(state.phase).toBe('await');
  });

  it('card message transitions to card phase', () => {
    const state = makeState();
    const ctx = makeCtx();
    applyServerMessage(
      state,
      { type: 'card', content: 'Confirm?', cardId: 'c1', kind: 'confirm' },
      ctx,
    );
    expect(state.phase).toBe('card');
    expect(state.isWaiting).toBe(true);
    expect(state.hasPendingCard).toBe(true);
    expect(state.messages.some((m) => m.type === 'card' && m.card?.cardId === 'c1')).toBe(true);
  });

  it('auto:on from idle transitions to await', () => {
    const state = makeState();
    const ctx = makeCtx();
    applyServerMessage(state, { type: 'auto', content: 'on' }, ctx);
    expect(state.phase).toBe('await');
    expect(state.isAutoMode).toBe(true);
  });

  it('running:off routes working → await when auto mode is on (空窗 vacuum fix)', () => {
    const state = makeState();
    const ctx = makeCtx();
    // Auto mode turn in progress: auto:on, then running:on as work starts.
    applyServerMessage(state, { type: 'auto', content: 'on' }, ctx);
    applyServerMessage(state, { type: 'running', content: 'on' }, ctx);
    expect(state.phase).toBe('working');
    // Turn ends: running:off fires (state_transition STOP→prompt), but the
    // auto loop redirects to AWAIT — no 'prompt' broadcast ever follows
    // (prompt.ts returns AWAIT before getInput(), and the idempotent
    // setAuto(true) fires no corrective auto:on). The client must rest at
    // 'await', NOT 'idle' — idle+auto would light the 空窗(疑似失同步) vacuum
    // warning forever (the long-lived-client bug from the 09:44 screenshot).
    applyServerMessage(state, { type: 'running', content: 'off' }, ctx);
    expect(state.phase).toBe('await');
    expect(state.isAutoMode).toBe(true);
    expect(state.isRunning).toBe(false);
    expect(state.isWaiting).toBe(false);
    // The next auto-mode turn still transitions correctly from await:
    applyServerMessage(state, { type: 'running', content: 'on' }, ctx);
    expect(state.phase).toBe('working');
  });

  it('running:off routes submitted → await when auto mode is on', () => {
    const state = makeState();
    const ctx = makeCtx();
    applyServerMessage(state, { type: 'auto', content: 'on' }, ctx);
    // Simulate the optimistic submitted phase (chatApi.sendInput latch).
    state.setPhase('submitted');
    applyServerMessage(state, { type: 'running', content: 'off' }, ctx);
    expect(state.phase).toBe('await');
  });

  it('running:off still routes working → idle when auto mode is off (manual regression guard)', () => {
    const state = makeState();
    const ctx = makeCtx();
    applyServerMessage(state, { type: 'running', content: 'on' }, ctx);
    applyServerMessage(state, { type: 'running', content: 'off' }, ctx);
    expect(state.phase).toBe('idle');
  });

  it('reconnect replay [auto:on, running:off] from fresh store settles at await', () => {
    const state = makeState();
    const ctx = makeCtx();
    // serve-hub.ts onWsConnection replay order: auto:on (if auto) first,
    // then running:off (agentRunning=false in AWAIT).
    applyServerMessage(state, { type: 'auto', content: 'on' }, ctx);
    applyServerMessage(state, { type: 'running', content: 'off' }, ctx);
    expect(state.phase).toBe('await');
  });

  it('auto:on while working stays working (flips boolean only)', () => {
    const state = makeState();
    const ctx = makeCtx();
    applyServerMessage(state, { type: 'running', content: 'on' }, ctx);
    expect(state.phase).toBe('working');
    applyServerMessage(state, { type: 'auto', content: 'on' }, ctx);
    expect(state.phase).toBe('working');
    expect(state.isAutoMode).toBe(true);
  });

  it('auto:off is NO-OP unless phase === await', () => {
    const state = makeState();
    const ctx = makeCtx();
    // From working, auto:off is a no-op on phase (only flips the boolean).
    applyServerMessage(state, { type: 'running', content: 'on' }, ctx);
    expect(state.phase).toBe('working');
    applyServerMessage(state, { type: 'auto', content: 'on' }, ctx);
    expect(state.phase).toBe('working'); // auto:on while working stays working
    expect(state.isAutoMode).toBe(true);
    applyServerMessage(state, { type: 'auto', content: 'off' }, ctx);
    expect(state.phase).toBe('working'); // auto:off from working is NO-OP
    expect(state.isAutoMode).toBe(false);
    // From await, auto:off → idle. First reach await: working → idle → await.
    applyServerMessage(state, { type: 'running', content: 'off' }, ctx);
    expect(state.phase).toBe('idle');
    applyServerMessage(state, { type: 'auto', content: 'on' }, ctx);
    expect(state.phase).toBe('await');
    applyServerMessage(state, { type: 'auto', content: 'off' }, ctx);
    expect(state.phase).toBe('idle');
  });

  it('default branch transitions prompt → working on agent output', () => {
    const state = makeState();
    const ctx = makeCtx();
    applyServerMessage(state, { type: 'prompt', content: '' }, ctx);
    expect(state.phase).toBe('prompt');
    // A non-control message (result) means the agent resumed → working.
    applyServerMessage(state, { type: 'result', content: 'done' }, ctx);
    expect(state.phase).toBe('working');
  });

  it('default branch does NOT change phase when already working', () => {
    const state = makeState();
    const ctx = makeCtx();
    applyServerMessage(state, { type: 'running', content: 'on' }, ctx);
    expect(state.phase).toBe('working');
    applyServerMessage(state, { type: 'result', content: 'more output' }, ctx);
    expect(state.phase).toBe('working');
  });
});

describe('applyServerMessage — routing', () => {
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
    expect(state.phase).toBe('prompt');
  });
});

describe('applyServerMessage — synthetic filter (machine-originated briefs)', () => {
  it('does NOT push a synthetic message into messages or teammateMessages', () => {
    const state = makeState();
    const ctx = makeCtx();
    applyServerMessage(state, { type: 'log', content: 'hook brief', label: 'hook', synthetic: true }, ctx);
    applyServerMessage(state, { type: 'log', content: 'hook @team', label: '@bob/hook', synthetic: true }, ctx);
    expect(state.messages).toHaveLength(0);
    expect(state.teammateMessages).toHaveLength(0);
  });

  it('synthetic message still transitions prompt/card → working (phase semantics intact)', () => {
    const state = makeState();
    const ctx = makeCtx();
    applyServerMessage(state, { type: 'prompt', content: '' }, ctx);
    expect(state.phase).toBe('prompt');
    applyServerMessage(state, { type: 'log', content: 'hook brief', label: 'hook', synthetic: true }, ctx);
    expect(state.phase).toBe('working');
    expect(state.messages).toHaveLength(0);
  });

  it('synthetic message is still recorded in lastServerMsg (diagnostic)', () => {
    const state = makeState();
    const ctx = makeCtx();
    applyServerMessage(state, { type: 'log', content: 'hook brief', label: 'hook', synthetic: true }, ctx);
    expect(state.lastServerMsg?.type).toBe('log');
  });

  it('non-synthetic messages are unaffected by the filter', () => {
    const state = makeState();
    const ctx = makeCtx();
    applyServerMessage(state, { type: 'log', content: 'normal brief', label: 'bash' }, ctx);
    applyServerMessage(state, { type: 'log', content: 'normal brief no synthetic flag', label: 'hook', synthetic: false }, ctx);
    expect(state.messages).toHaveLength(2);
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
    // fall-through (the prompt → working transition under investigation).
    applyServerMessage(state, { type: 'result', content: 'wrap-up summary' }, ctx);
    expect(state.lastServerMsg?.type).toBe('result');
    expect(state.isWaiting).toBe(false); // default branch transitioned to working
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