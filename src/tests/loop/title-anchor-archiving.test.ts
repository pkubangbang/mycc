/**
 * title-anchor-archiving.test.ts — sign-off tests for the title-anchor segment
 * archiving feature (peer review gate after 8aaf696).
 *
 * Four peer-mandated cases:
 *  1. append during summarization → archive still installs (c697bdc invariant);
 *  2. store shrink during summarization → abort, store untouched;
 *  3. mycc_title trigger passes the ASSISTANT index, never fires for non-title;
 *  4. compact() propagates a runAutoCompact rejection and the chain stays usable.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub the summarizer so no LLM call is made; tests control its resolution.
const autoCompactMock = vi.fn();
vi.mock('../../loop/triologue/compact.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../loop/triologue/compact.js')>();
  return { ...orig, runAutoCompact: (...args: unknown[]) => autoCompactMock(...args) };
});

vi.mock('../../loop/agent-io.js', () => ({
  agentIO: { brief: vi.fn(), verbose: vi.fn(), log: vi.fn(), isNeglectedMode: () => false },
}));

vi.mock('../../config.js', () => ({
  isVerbose: vi.fn(() => false),
  // TP auto-recovery consults these before dispatching a fix; without them
  // Triologue.user() throws on the misorder path and the trigger never runs.
  isDebuggingTp: vi.fn(() => false),
  getApiProvider: vi.fn(() => 'ollama'),
  getLongtextDir: vi.fn(() => '/tmp/lt'),
  ensureDirs: vi.fn(),
  getSessionContext: vi.fn(() => 'test-session'),
  getSessionDir: vi.fn(() => '/tmp/sess'),
}));

vi.mock('../../engine/chat-provider.js', () => ({
  forkChat: vi.fn(),
  retryChat: vi.fn(),
  MODEL: 'test-model',
}));

vi.mock('../../context/shared/loader.js', () => ({
  loader: { execute: vi.fn() },
}));

import { Triologue } from '../../loop/triologue.js';
// The mycc_title handler prints an OSC title via agentIO; mocked above, so
// nothing touches the real terminal.
import { handleTool } from '../../loop/states/tool.js';
import { loader } from '../../context/shared/loader.js';
import type { Message, ToolCall } from '../../types.js';

function mkTriologue(): Triologue {
  return new Triologue({
    tokenThreshold: 1_000_000, // never auto-triggers
    resultThreshold: 100000,
    hintThreshold: 1000,
    onMisorder: () => {},
    onToolMisalign: () => {},
    onCompact: () => {},
    onMessage: () => {},
  });
}

function titleAssistant(id: string): Message {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [{ id, type: 'function', function: { name: 'mycc_title', arguments: { title: 't' } } } as ToolCall],
  };
}
function toolResult(id: string, name = 'mycc_title'): Message {
  return { role: 'tool', tool_name: name, content: 'OK', tool_call_id: id };
}
function summaryTriple(): Message[] {
  return [
    { role: 'user', content: '[summary] archived' },
    { role: 'assistant', content: '', tool_calls: [{ id: 's', type: 'function', function: { name: 'brief', arguments: {} } } as ToolCall] },
    { role: 'tool', tool_name: 'brief', content: 'OK', tool_call_id: 's' },
  ];
}

/**
 * Seed the store with an EARLIER complete title batch (the archive anchor)
 * followed by the TRIGGERING title batch. The latter cannot serve as its own
 * anchor — previousTitleAnchorEnd only returns batches ending strictly before
 * it — so both are needed for compactSegment to have a segment to archive.
 */
function seedTitleBatch(t: Triologue, bulkFirst = true): { titleAssistantIdx: number; anchorEnd: number } {
  const store = (t as unknown as { store: { push(m: Message): void; getRaw(): Message[] } }).store;
  if (bulkFirst) store.push({ role: 'user', content: 'x'.repeat(9000) }); // pass the 2k trivial gate
  store.push(titleAssistant('t0'));
  const anchorEnd = store.getRaw().length; // last result of the EARLIER batch
  store.push(toolResult('t0'));
  const titleAssistantIdx = store.getRaw().length;
  store.push(titleAssistant('t1'));
  return { titleAssistantIdx, anchorEnd };
}

describe('compactSegment fingerprint (peer cases 1-2)', () => {
  beforeEach(() => autoCompactMock.mockReset());

  it('append during summarization still installs the archive', async () => {
    const t = mkTriologue();
    const { titleAssistantIdx, anchorEnd } = seedTitleBatch(t);
    const lenBefore = t.getMessagesRaw().length;

    autoCompactMock.mockImplementation(async () => {
      // The agent keeps working while summarization runs: append a message.
      t.user('appended during summarization');
      return summaryTriple();
    });

    await t.compactSegment(titleAssistantIdx);

    const raw = t.getMessagesRaw();
    // The archive is anchored at the EARLIER batch (t0): its end index is
    // anchorEnd, so the last message the summary covers is t0's result. Triple
    // (3) replaces [0 … anchorEnd]; the tail keeps t1's tool result and the
    // append replayed after it (a legal tool → user transition once t1 settled,
    // and Triologue.user() then bridges/updates rather than interposing).
    expect(raw.length).toBe(3 + (lenBefore - (anchorEnd + 1)) + 1);
    expect(raw[0].role).toBe('user'); // summary head
    const tail = raw.slice(3);
    expect(tail[0]).toMatchObject({ role: 'assistant' });
    expect((tail[0].tool_calls?.[0] as ToolCall).id).toBe('t1');
    // Append during summarization: DEFERRED at compactSegment() time (a user
    // message may not be interposed after a tool role), then flushed once the
    // deferred batch settled — the work done while summarizing is not lost and
    // the archive still installed on the pre-append conversation.
    expect(tail.some((m) => m.role === 'user' && m.content === 'appended during summarization')).toBe(true);
  });

  it('store shrink during summarization aborts and leaves the store untouched', async () => {
    const t = mkTriologue();
    const { titleAssistantIdx } = seedTitleBatch(t);

    autoCompactMock.mockImplementation(async () => {
      // Simulate a full compact swapping (shrinking) the store mid-flight.
      t.installCompacted(summaryTriple());
      return summaryTriple();
    });

    await t.compactSegment(titleAssistantIdx);

    // Aborted: store is whatever the full compact installed, NOT a segment splice.
    expect(t.getMessagesRaw().length).toBe(3);
  });
});

describe('title trigger wiring (peer case 3)', () => {
  it('compactSegment gets the ASSISTANT index for mycc_title, never fires for other tools', async () => {
    const t = mkTriologue();
    const spy = vi.spyOn(t, 'compactSegment').mockResolvedValue(undefined);
    vi.mocked(loader.execute).mockResolvedValue('OK');

    // escAware receives the executor plus a fallback; the executor takes the
    // AbortController handleTool builds internally.
    const core = {
      escAware: async (fn: (ac: AbortController) => Promise<string>) => fn(new AbortController()),
      increaseConfusionIndex: vi.fn(),
    };
    const env = {
      triologue: t,
      ctx: { core },
      sequence: { add: vi.fn() },
      requestEmbeddingTracker: { addEntry: vi.fn(async () => {}), getMaxSimilarity: vi.fn(() => 0), similarityToDelta: vi.fn(() => -1) },
    } as never;
    const turn = { nextBriefNudge: 0 } as never;

    // Seed the assistant batch carrying tc1 so the trigger's true-array scan
    // finds it. handleTool lands the result via triologue.tool() first, so the
    // assistant index (0) is the LAST message when the scan runs.
    const store = (t as unknown as { store: { push(m: Message): void } }).store;
    store.push(titleAssistant('tc1'));

    const chat = {
      hookResult: { calls: [{ id: 'tc1', function: { name: 'mycc_title', arguments: { title: 'x' } } }], blockedCalls: new Map() },
    } as never;
    await handleTool(env, turn, chat);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe(0); // assistant index, not -1, not the result index

    spy.mockClear();
    const chat2 = {
      hookResult: { calls: [{ id: 'tc2', function: { name: 'read_file', arguments: {} } }], blockedCalls: new Map() },
    } as never;
    await handleTool(env, turn, chat2);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('concurrency invariants (lead steering)', () => {
  beforeEach(() => autoCompactMock.mockReset());

  it('INV1: an archive that spans a full compact discards its result', async () => {
    const t = mkTriologue();
    const { titleAssistantIdx } = seedTitleBatch(t);
    const epochOf = () => (t as unknown as { compactionEpoch: number }).compactionEpoch;
    autoCompactMock.mockImplementation(async () => {
      // A full compact lands while the archive is summarizing. Simulated on the
      // epoch itself: compact() enqueues on the SAME chain, so calling it from
      // inside the archive body would deadlock by construction (no re-entrancy).
      (t as unknown as { compactionEpoch: number }).compactionEpoch++;
      return summaryTriple();
    });
    // The epoch moved → the archive's summary is stale and must NOT be spliced.
    await expect(t.compactSegment(titleAssistantIdx)).resolves.toBeUndefined();
    expect(epochOf()).toBe(1);
  });

  it('INV2: an in-flight batch in the tail is refused (known, deliberate) and nothing changes', () => {
    // Peer review RISK (store #2 / facade #5): a tail whose batch still has an
    // unanswered call cannot be spliced — the guard cannot prove the head does
    // not hold the matching result. The install must REFUSE all-or-nothing, so
    // neither the ledger nor the deferred input is touched (a full compact's
    // invariant set would have cleared BOTH). The tail's later settle flushes the
    // deferred input normally.
    const t = mkTriologue();
    t.user('q1');
    t.agent('a1');
    t.agent('a0');
    t.agent('', [
      titleAssistant('t1').tool_calls![0] as ToolCall,
      { id: 't2', type: 'function', function: { name: 'read_file', arguments: {} } } as ToolCall,
    ]);
    t.tool('mycc_title', 'OK', 't1'); // ledger: t2 still pending
    t.user('typed while archiving'); // DEFERRED
    const before = t.getMessagesRaw().length;

    expect(t.installCompacted(summaryTriple(), 2)).toBe(false);
    expect(t.getMessagesRaw().length).toBe(before); // store untouched
    expect(t.getMessagesRaw().some((m) => m.content === 'typed while archiving')).toBe(false);

    // Once t2's result lands the ledger empties and the deferred input replays.
    t.tool('read_file', 'R', 't2');
    expect(t.getMessagesRaw().some((m) => m.content === 'typed while archiving')).toBe(true);
  });
});

