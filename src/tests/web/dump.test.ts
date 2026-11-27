/**
 * dump.test.ts - the CLIENT half of `window.$webui.dump()` (src/web/src/dump.ts)
 *
 * A dump exists to answer questions about an INSTANT that no longer exists by
 * the time anyone reads the code: which frames crossed the socket, which ones
 * the cursor gate discarded, which rendered rows the server never confirmed.
 * So these tests pin the three properties that make the artifact trustworthy:
 *
 *   1. the rings stay BOUNDED (a diagnostic that can leak is not a diagnostic);
 *   2. a frame is recorded even when the gate would drop it — the evidence a
 *      duplicate-row investigation needs is exactly what the gate throws away;
 *   3. the summary numbers are computed at CAPTURE time, because "user rows with
 *      no seq" and "frames dropped by the gate" are the two facts that answer
 *      "shown twice?" and "lost?" at a glance.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  DUMP_FORMAT,
  DEFAULT_RING_CAPACITY,
  FrameRing,
  truncateContent,
  recordFrame,
  toDumpMessage,
  buildClientSlice,
  mergeDump,
  serializeDump,
  dumpFilename,
  dumpSummaryLine,
  type ClientFrame,
  type DumpMessage
} from '../../web/src/dump.js';

describe('FrameRing — bounded, oldest-first, copy-on-read', () => {
  it('keeps the newest N frames and evicts the oldest', () => {
    const ring = new FrameRing(3);
    for (let i = 1; i <= 5; i++) ring.push({ t: i, dir: 'in', type: 'log' });
    expect(ring.snapshot().map((f) => f.t)).toEqual([3, 4, 5]);
    expect(ring.size).toBe(3);
  });

  it('returns a COPY — a caller cannot mutate the ring through snapshot()', () => {
    const ring = new FrameRing(2);
    ring.push({ t: 1, dir: 'in', type: 'log' });
    ring.snapshot()[0].type = 'tampered';
    expect(ring.snapshot()[0].type).toBe('log');
  });

  it('clamps a non-positive capacity instead of silently recording nothing', () => {
    // A capacity of 0 would make push() discard every frame while claiming to
    // record — a dump that says "no traffic" during an incident it missed.
    const ring = new FrameRing(0);
    ring.push({ t: 1, dir: 'in', type: 'log' });
    expect(ring.size).toBe(1);
  });

  it('defaults to a window big enough for send → ESC → send', () => {
    expect(DEFAULT_RING_CAPACITY).toBeGreaterThanOrEqual(200);
  });
});

describe('truncateContent — keep dumps attachable, keep the size readable', () => {
  it('leaves short content untouched', () => {
    expect(truncateContent('hi')).toBe('hi');
  });

  it('marks a cut with the ORIGINAL length, so a reader knows what was lost', () => {
    const out = truncateContent('x'.repeat(50), 10);
    expect(out.startsWith('xxxxxxxxxx')).toBe(true);
    expect(out).toContain('(50 chars)');
    expect(out.length).toBeLessThan(50);
  });
});

describe('recordFrame — tolerant of every wire shape', () => {
  it('records a normal row frame with its seq and label', () => {
    const f = recordFrame({ type: 'log', seq: 42, label: 'bash', content: 'ok' }, 'in', {}, 1000);
    expect(f).toMatchObject({ t: 1000, dir: 'in', type: 'log', seq: 42, label: 'bash', content: 'ok' });
  });

  it('falls back to the card `query` when there is no `content`', () => {
    const f = recordFrame({ type: 'card', query: 'proceed?' }, 'in');
    expect(f.content).toBe('proceed?');
  });

  it('still records SOMETHING for a malformed frame', () => {
    // A missing frame is the one fact a diagnosis cannot recover from.
    expect(recordFrame(null, 'in').type).toBe('(malformed)');
    expect(recordFrame('not an object', 'in').type).toBe('(malformed)');
    expect(recordFrame({}, 'in').type).toBe('(malformed)');
  });

  it('drops a non-finite seq rather than printing NaN into the artifact', () => {
    expect(recordFrame({ type: 'log', seq: Number.NaN }, 'in').seq).toBeUndefined();
  });

  it('carries the gate verdict and the send verdict when given', () => {
    expect(recordFrame({ type: 'log' }, 'in', { droppedByGate: true }).droppedByGate).toBe(true);
    expect(recordFrame({ type: 'input' }, 'out', { sent: false }).sent).toBe(false);
  });

  it('does not invent absent verdicts (undefined ≠ false)', () => {
    const f = recordFrame({ type: 'input' }, 'out');
    expect('sent' in f).toBe(false);
    expect('droppedByGate' in f).toBe(false);
  });
});

describe('toDumpMessage — the row fields a duplicate investigation reads', () => {
  it('keeps seq / id / optimistic and truncates the body', () => {
    const m = toDumpMessage({ type: 'user', id: 7, optimistic: true, content: 'q'.repeat(1000) });
    expect(m.id).toBe(7);
    expect(m.optimistic).toBe(true);
    expect(m.content).toContain('(1000 chars)');
  });

  it('omits absent optional fields instead of writing undefined keys', () => {
    const m = toDumpMessage({ type: 'log' });
    expect(Object.keys(m)).toEqual(['type', 'content']);
  });
});

const frame = (over: Partial<ClientFrame> = {}): ClientFrame => ({ t: 1, dir: 'in', type: 'log', ...over });
const msg = (over: Partial<DumpMessage> = {}): DumpMessage => ({ type: 'log', content: 'x', ...over });

describe('mergeDump — the summary answers "twice?" and "lost?" at a glance', () => {
  const client = buildClientSlice({
    capturedAt: 5000,
    href: 'http://localhost:3173/',
    userAgent: 'test',
    wsUrl: 'ws://localhost:3173/ws',
    reconnects: 2,
    state: {
      phase: 'prompt',
      isAutoMode: false,
      isPlanMode: false,
      isWaiting: true,
      isRunning: false,
      hasPendingCard: false,
      connectionStatus: 'connected',
      inputText: 'draft',
      pendingFiles: ['a.png'],
      steeringBuffer: [],
      pendingSteeringReview: []
    },
    cursor: { lastRenderedSeq: 12, clearBoundarySeq: 0, historyDirty: false, lastHistoryEtag: 'abc', sessionId: 's1' },
    messages: [
      msg({ type: 'user', seq: 3 }),
      // An orphan echo: user text with no journal seq — the "shown twice" row.
      msg({ type: 'user', optimistic: true }),
      msg({ type: 'log', seq: 4 })
    ],
    teammateMessages: [],
    frames: [
      frame({ t: 1, dir: 'out', type: 'input' }),
      frame({ t: 2, dir: 'in', type: 'running' }),
      frame({ t: 3, dir: 'in', type: 'log', seq: 3, droppedByGate: true }),
      frame({ t: 4, dir: 'in', type: 'log', seq: 9 })
    ]
  });

  it('stamps the format tag and the capture time', () => {
    const dump = mergeDump(client, { diagnostics: {} });
    expect(dump.format).toBe(DUMP_FORMAT);
    expect(dump.capturedAt).toBe(5000);
  });

  it('counts user rows with NO seq — each is an unconfirmed bubble', () => {
    expect(mergeDump(client, null).summary.optimisticUserRows).toBe(1);
  });

  it('counts frames the gate discarded (duplicates it PREVENTED)', () => {
    const dump = mergeDump(client, null);
    expect(dump.summary.droppedByGate).toBe(1);
    expect(dump.summary.framesIn).toBe(3);
    expect(dump.summary.framesOut).toBe(1);
  });

  it('records an unreachable server as a FACT, not a failure', () => {
    // The dump taken BECAUSE the server stopped answering must still download.
    const dump = mergeDump(client, null, 'GET /dump → HTTP 500');
    expect(dump.server).toBeNull();
    expect(dump.serverError).toBe('GET /dump → HTTP 500');
    expect(dumpSummaryLine(dump)).toContain('server=UNREACHABLE');
  });

  it('omits serverError entirely when the server slice arrived', () => {
    const dump = mergeDump(client, { diagnostics: { running: true } });
    expect('serverError' in dump).toBe(false);
    expect(dumpSummaryLine(dump)).toContain('server=ok');
  });

  it('deep-copies what it is given (a later store mutation cannot rewrite the dump)', () => {
    const dump = mergeDump(client, null);
    client.messages[0].content = 'mutated later';
    expect(dump.client.messages[0].content).toBe('x');
  });
});

describe('dumpFilename / serializeDump', () => {
  it('names the file with the session and a filesystem-safe timestamp', () => {
    const name = dumpFilename('487cc028-299b', Date.UTC(2026, 10, 20, 13, 29, 15));
    expect(name).toBe('mycc-webui-dump-487cc028-299b-2026-11-20T13-29-15.json');
  });

  it('degrades to no-session instead of producing a nameless file', () => {
    expect(dumpFilename(null, 0)).toContain('no-session');
  });

  it('is pretty-printed — a human reads it before an agent does', () => {
    const dump = mergeDump(
      buildClientSlice({
        capturedAt: 1,
        href: '',
        userAgent: '',
        wsUrl: null,
        reconnects: 0,
        state: {
          phase: 'idle',
          isAutoMode: false,
          isPlanMode: false,
          isWaiting: false,
          isRunning: false,
          hasPendingCard: false,
          connectionStatus: 'connected',
          inputText: '',
          pendingFiles: [],
          steeringBuffer: [],
          pendingSteeringReview: []
        },
        cursor: { lastRenderedSeq: 0, clearBoundarySeq: 0, historyDirty: false, lastHistoryEtag: null, sessionId: null },
        messages: [],
        teammateMessages: [],
        frames: []
      }),
      null
    );
    expect(serializeDump(dump)).toContain('\n  "format": "mycc.webui.dump/1"');
  });
});
