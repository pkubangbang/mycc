/**
 * serve-diag.test.ts — the SERVER half of `window.$webui.dump()` (src/serve/serve-diag.ts)
 *
 * The defect these diagnostics exist for is a submission that is SILENTLY
 * DROPPED: ServeHub.submitInput's `else` branch answers nothing, journals
 * nothing and logs nothing, so a lost query used to leave no trace anywhere.
 * The ring's job is to make that decision a recorded fact. So the tests below
 * pin the three things that make it usable as evidence:
 *
 *   1. the status is sampled at ARRIVAL (before submitInput consumes the
 *      resolver) — sampling afterwards would report "nothing armed" for every
 *      delivered frame and make the dump lie about the case it explains;
 *   2. `dropped` is a NAMED outcome, not an absence;
 *   3. the ring stays bounded — a diagnostic that can leak is not a diagnostic.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  DEFAULT_DIAG_CAPACITY,
  FRAME_TEXT_LIMIT,
  InboundFrameRing,
  recordInbound,
  inputStatus,
  buildServerDumpSlice,
  summarizeFrames,
  type ServerDiagnostics
} from '../../serve/serve-diag.js';

describe('inputStatus — the ONE rule the diagnosis turns on', () => {
  it('is delivered when a prompt wait is armed', () => {
    expect(inputStatus(true, false)).toBe('delivered');
    // An armed resolver wins even with a card pending: submitInput resolves the
    // prompt and never reaches the card branch.
    expect(inputStatus(true, true)).toBe('delivered');
  });

  it('is card-pending when only a card resolver is waiting', () => {
    expect(inputStatus(false, true)).toBe('card-pending');
  });

  it('is DROPPED when neither is waiting — the silent `else` this file exists for', () => {
    expect(inputStatus(false, false)).toBe('dropped');
  });
});

describe('recordInbound — sampled at arrival, before dispatch', () => {
  it('records type/text plus the bridge state it was judged under', () => {
    const f = recordInbound({ type: 'input', text: 'hello' }, { armed: false, cardPending: false }, 4242);
    expect(f).toEqual({ t: 4242, type: 'input', text: 'hello', armed: false, cardPending: false });
  });

  it('keeps the armed flag even when a later call would consume the resolver', () => {
    // The arrival sample is the whole point: submitInput sets inputResolver to
    // null as it resolves, so a post-hoc read would say `false` here.
    const f = recordInbound({ type: 'input', text: 'x' }, { armed: true, cardPending: false }, 1);
    expect(f.armed).toBe(true);
  });

  it('records file NAMES only — base64 bodies would bury the dump', () => {
    const f = recordInbound(
      { type: 'steer', text: 'see attached', files: [{ filename: 'a.png', data: 'A'.repeat(10000) }] },
      { armed: false, cardPending: false }
    );
    expect(f.fileNames).toEqual(['a.png']);
    expect(JSON.stringify(f)).not.toContain('AAAAAAAAAA');
  });

  it('marks an unnamed file instead of dropping the entry silently', () => {
    const f = recordInbound({ type: 'input', files: [{}] }, { armed: false, cardPending: false });
    expect(f.fileNames).toEqual(['(unnamed)']);
  });

  it('truncates a long text but reports its real length', () => {
    const f = recordInbound({ type: 'input', text: 'y'.repeat(FRAME_TEXT_LIMIT * 3) }, { armed: true, cardPending: false });
    expect(f.text).toContain(`(${FRAME_TEXT_LIMIT * 3} chars)`);
    expect(f.text!.length).toBeLessThan(FRAME_TEXT_LIMIT * 3);
  });

  it('names a malformed message rather than recording an empty type', () => {
    expect(recordInbound({}, { armed: false, cardPending: false }).type).toBe('(malformed)');
  });
});

describe('InboundFrameRing — bounded and immutable-from-outside', () => {
  it('keeps the newest frames and evicts the oldest', () => {
    const ring = new InboundFrameRing(2);
    ring.push({ t: 1, type: 'input' });
    ring.push({ t: 2, type: 'input' });
    ring.push({ t: 3, type: 'input' });
    expect(ring.snapshot().map((f) => f.t)).toEqual([2, 3]);
  });

  it('returns a copy so a dump cannot tear the ring mid-serialize', () => {
    const ring = new InboundFrameRing(4);
    ring.push({ t: 1, type: 'input' });
    ring.snapshot()[0].type = 'tampered';
    expect(ring.snapshot()[0].type).toBe('input');
  });

  it('defaults to a window that covers a send → ESC → send incident', () => {
    expect(DEFAULT_DIAG_CAPACITY).toBeGreaterThanOrEqual(200);
  });
});

const diag = (over: Partial<ServerDiagnostics> = {}): ServerDiagnostics => ({
  running: true,
  port: 3173,
  host: null,
  agentRunning: false,
  auto: false,
  mode: 'normal',
  clients: 1,
  inputArmed: true,
  cardResolvers: 0,
  steeringRevision: 3,
  steeringNotes: [],
  fileUploads: 0,
  messageLogLength: 10,
  historyRows: 42,
  historyMaxSeq: 99,
  ...over
});

describe('buildServerDumpSlice / summarizeFrames', () => {
  it('copies the diagnostics and every frame', () => {
    const frames = [{ t: 1, type: 'input', status: 'dropped' as const }];
    const slice = buildServerDumpSlice(diag(), frames);
    expect(slice.diagnostics.historyMaxSeq).toBe(99);
    expect(slice.frames[0].status).toBe('dropped');
    frames[0].type = 'mutated';
    expect(slice.frames[0].type).toBe('input');
  });

  it('summarises by status, and names frames that never carried one', () => {
    const counts = summarizeFrames([
      { t: 1, type: 'input', status: 'delivered' },
      { t: 2, type: 'input', status: 'dropped' },
      { t: 3, type: 'input', status: 'dropped' },
      { t: 4, type: 'interrupt' }
    ]);
    expect(counts).toEqual({ delivered: 1, dropped: 2, 'interrupt:no-status': 1 });
  });
});
