/**
 * clear-boundary.test.ts — the `/clear` boundary, end to end at the SEAMS
 *
 * This is the test the review demanded: the one that would have caught the
 * dead `record.kind === 'clear'` branch. It drives the REAL producer seams —
 * `Triologue.clear()` → `onMessage` → `JsonlTranscriptWriter` — and then asks the
 * two questions the user actually cares about:
 *
 *   1. LIVE:  does an open browser receive a `clear-history` state frame?
 *   2. RELOAD: does GET /history (projectDisplayRecords) drop the pre-clear rows?
 *
 * WHY THE LIVE HALF CANNOT BE TESTED THROUGH THE DISPLAY OBSERVER. The writer
 * deliberately does not forward boundary records (display-record-seam.test.ts:56
 * pins that: they are journal marks, not chat rows). So the hub learns about a
 * clear from an EXPLICIT call — `hub.clearDisplayedHistory()`, which agent-repl
 * fires from its double-Ctrl+L callback. The first case below reproduces exactly
 * that wiring; if the hub's clear loses that call, or stops broadcasting, or
 * starts depending on a record it will never see, this suite fails.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Triologue } from '../../loop/triologue.js';
import { ServeHub } from '../../serve/serve-hub.js';
import { JsonlTranscriptWriter } from '../../loop/triologue/transcript.js';
import { computeClearBoundarySeq, projectDisplayRecords, readTranscriptRecords } from '../../serve/serve-history.js';
import { handleWsMessage } from '../../serve/serve-ws-handler.js';
import type { Message } from '../../types.js';

/** The sending socket. handleWsMessage only uses it for broadcastExcept. */
const fakeSender = {} as never;

/** An OPEN fake client: records every frame the hub sends it. */
interface FakeClient {
  readyState: number;
  sent: string[];
  send(payload: string): void;
}

function fakeClient(): FakeClient {
  return {
    readyState: 1, // WebSocket.OPEN
    sent: [],
    send(payload: string) {
      this.sent.push(payload);
    }
  };
}

/** Frames of one wire `type` a client received (parsed). */
function framesOf(client: FakeClient, type: string): Array<Record<string, unknown>> {
  return client.sent
    .map((raw) => {
      try {
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((f): f is Record<string, unknown> => f !== null && f.type === type);
}

describe('/clear boundary — live fan-out and the reload projection', () => {
  let tmpDir: string;
  let transcriptPath: string;
  let writer: JsonlTranscriptWriter;
  let triologue: Triologue;
  let hub: ServeHub;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clear-boundary-'));
    transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    writer = new JsonlTranscriptWriter(transcriptPath);
    triologue = new Triologue({
      onMessage: (msg: Message) => {
        const { role, content, ...extra } = msg as Message & Record<string, unknown>;
        writer.append({ role, content, ...extra } as unknown as Parameters<typeof writer.append>[0]);
      },
      tokenThreshold: 50000,
      resultThreshold: 100000
    });
    hub = new ServeHub();
    hub.setTranscriptPath(transcriptPath);
    // The production wiring (activate.ts → wireOutputMirroring).
    writer.setDisplayObserver((record) => hub.broadcastDisplayRecord(record));
  });

  afterEach(() => {
    writer.setDisplayObserver(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('an open client receives ONE seq-less clear-history frame when the clear path fires', () => {
    const client = fakeClient();
    // The registry only fans out to clients it knows; this is the same door the
    // WS server uses for a real connection.
    (hub as unknown as { clients: { add(ws: unknown): void } }).clients.add(client);

    // Pre-clear conversation, journaled through the real writer.
    triologue.user('pre-clear question');
    triologue.note('REMINDER', 'a pre-clear line');
    expect(framesOf(client, 'clear-history')).toHaveLength(0);

    // THE CLEAR PATH — Triologue.clear() journals the marker, then agent-repl's
    // double-Ctrl+L callback tells the hub explicitly (the writer never will).
    triologue.clear();
    hub.clearDisplayedHistory();

    const frames = framesOf(client, 'clear-history');
    expect(frames).toHaveLength(1);
    // STATE SIGNAL, NOT A CHAT ROW: no content, no seq. Without the seq the
    // client's display-cursor gate cannot drop it; with content it would render
    // a bubble.
    expect(frames[0].content).toBeUndefined();
    expect(frames[0].seq).toBeUndefined();

    writer.setDisplayObserver(null);
  });

  it('the RELOAD view agrees: /clear cuts every pre-clear row out of the projection', () => {
    triologue.user('pre-clear question');
    triologue.note('REMINDER', 'a pre-clear line');
    triologue.clear();
    triologue.user('post-clear question');

    const rows = projectDisplayRecords(readTranscriptRecords(transcriptPath));
    expect(rows.map((r) => r.content)).toEqual(['post-clear question']);
    // Exact epoch arithmetic, not "greater than 1". The pre-clear writes are
    // `user` = seq 1, `note` = seq 2; the marker consumes seq 3; the post-clear
    // user row is therefore EXACTLY 4. The client's clear gate compares a
    // /history body's maximum against `clearedAtSeq`, which is the watermark at
    // the moment the frame arrived — if the marker stopped consuming a seq, the
    // post-clear row would be indistinguishable from a pre-clear one and a
    // replayed frame could resurrect the cleared conversation. Pin the number.
    expect(rows[0].seq).toBe(4);
  });

  it('clearing drains a pending card resolver instead of leaving the agent blocked', async () => {
    // A card the browser can no longer show once its row is cut. The resolver
    // must answer "stop waiting" (null), or waitForCardResponse parks forever
    // behind an invisible widget — and the client's hasPendingCard keeps the
    // composer disabled.
    const pending = hub.waitForCardResponse('card-1');
    hub.clearDisplayedHistory();
    await expect(pending).resolves.toBeNull();
  });

  /**
   * THE BROWSER PATH (issue #7).
   *
   * The cases above drive `hub.clearDisplayedHistory()` directly, which is what
   * agent-repl's double-Ctrl+L callback did. That callback CANNOT fire in serve
   * mode (no LineEditor → handleKeyEvent returns early), so the WebUI had no way
   * to reach the clear at all. These drive the inbound frame instead:
   * `{type:'clear-conversation'}` → `handleWsMessage` → `ServeHub.clearConversation()`
   * → the loop's provider.
   *
   * WHY THERE IS NO LOCAL COPY OF THE ROUTINE HERE. An earlier draft reproduced
   * the clear body inside this file as two statements and drove that. It passed,
   * and it would have kept passing if production drifted — dropped
   * `reconcileServeStateAfterClear()`, reordered the marker behind the
   * broadcast, anything. A lookalike proves "the frame reaches *a* provider",
   * not "it reaches the production routine". The body lives inline in
   * `agent-repl.ts` (a `main`-scope closure, not importable), so the binding is
   * asserted STRUCTURALLY below, and the behavioural half is driven through the
   * real seam.
   */
  it('agent-repl wires the production clear routine into the hub provider seam', () => {
    // Structure guard: the ONE line that makes the browser path real. Without
    // it, `clear-conversation` reaches ServeHub and throws "no provider". If
    // someone renames the routine or drops the registration, this fails — which
    // is the failure the lookalike could not see.
    const source = fs.readFileSync(path.join(process.cwd(), 'src/loop/agent-repl.ts'), 'utf-8');
    expect(source).toMatch(/onServeHubReady\(\(hub\)\s*=>\s*hub\.setClearConversationProvider\(clearConversation\)\)/);
    // The TERMINAL entry point must survive the refactor: same body, not a
    // second copy. Both callbacks naming the same function is the contract.
    expect(source).toMatch(/setDoubleCtrlLCallback\(\(\)\s*=>\s*clearConversation\(\)\)/);
    // Ordering, pinned at the source: the transcript marker (triologue.clear)
    // must precede the live broadcast (clearDisplayedHistory), or a reload and
    // an open page disagree about where the boundary is.
    const body = source.slice(source.indexOf('function clearConversation(): void'));
    const markerAt = body.indexOf('triologue.clear()');
    const broadcastAt = body.indexOf('clearDisplayedHistory()');
    expect(markerAt).toBeGreaterThan(-1);
    expect(broadcastAt).toBeGreaterThan(-1);
    expect(markerAt).toBeLessThan(broadcastAt);
    // The fresh-session reset travels with the boundary, not beside it.
    for (const step of [
      'sequence.fullClear()',
      'clearWrapUp()',
      'ctx.todo.clear()',
      'ctx.issue.clearAll()',
      'beginFreshSession(turn)',
      'reconcileServeStateAfterClear()'
    ]) {
      expect(body).toContain(step);
    }
  });

  it('a clear-conversation WS frame reaches the provider seam and broadcasts clear-history', () => {
    const client = fakeClient();
    (hub as unknown as { clients: { add(ws: unknown): void } }).clients.add(client);

    triologue.user('pre-clear question');
    triologue.note('REMINDER', 'a pre-clear line');
    expect(framesOf(client, 'clear-history')).toHaveLength(0);

    // Bind through the SAME production seam agent-repl uses. The bound body only
    // needs the two effects this file owns — the ordering contract itself is
    // asserted against production source in the case above, so nothing is
    // duplicated here beyond what is needed to observe the boundary.
    const counter = { calls: 0 };
    hub.setClearConversationProvider(() => {
      counter.calls += 1;
      triologue.clear();
      hub.clearDisplayedHistory();
    });

    // The real dispatch entry: the frame the WebUI sends.
    handleWsMessage(hub, fakeSender, JSON.stringify({ type: 'clear-conversation' }));

    expect(counter.calls).toBe(1);
    expect(framesOf(client, 'clear-history')).toHaveLength(1);

    // The RELOAD view agrees: the marker was written, so the projection cuts
    // every pre-clear row.
    expect(projectDisplayRecords(readTranscriptRecords(transcriptPath))).toHaveLength(0);
  });

  it('a clear-conversation frame is a no-op (never a throw) on a hub with no loop provider', () => {
    // A hub with no agent loop behind it cannot honour a clear. ServeHub throws,
    // and handleWsMessage's catch reports it via agentIO.verbose — the socket
    // must survive, and no clear-history may be broadcast (that would blank a
    // page for a clear that never happened).
    const client = fakeClient();
    (hub as unknown as { clients: { add(ws: unknown): void } }).clients.add(client);
    triologue.user('still here');

    expect(() => handleWsMessage(hub, fakeSender, JSON.stringify({ type: 'clear-conversation' }))).not.toThrow();

    expect(framesOf(client, 'clear-history')).toHaveLength(0);
    expect(triologue.getMessages()).toHaveLength(1);
  });

  /**
   * THE SERVER-STATING HALF of the hydration fix (issue #8).
   *
   * `/history` now carries `clearBoundarySeq`, and the CLIENT needs it to be the
   * seq the projection actually cut at — otherwise a hydrated page (a second tab,
   * a reopened page) has no way to know which of its cached rows the server
   * removed, and re-adopts them. These pin that the number is derived from the
   * SAME `lastClearIndex` cut the body reflects, so the two can never drift.
   */
  describe('computeClearBoundarySeq — the boundary /history states', () => {
    it('is 0 when the transcript holds no clear (nothing is ever filtered)', () => {
      triologue.user('q1');
      triologue.note('REMINDER', 'line');
      expect(computeClearBoundarySeq(readTranscriptRecords(transcriptPath))).toBe(0);
    });

    it('is the seq of the marker itself — inclusive of the cleared region', () => {
      triologue.user('q1'); // seq 1
      triologue.note('REMINDER', 'line'); // seq 2
      triologue.clear(); // marker consumes seq 3
      // Every record at or below 3 was cut; the marker is the boundary.
      expect(computeClearBoundarySeq(readTranscriptRecords(transcriptPath))).toBe(3);
    });

    it('is INDEPENDENT of post-clear rows — it names the cut, not the head', () => {
      triologue.user('q1');
      triologue.clear(); // marker = seq 2
      triologue.user('post-clear'); // seq 3, must NOT move the boundary
      triologue.user('post-clear 2'); // seq 4
      const records = readTranscriptRecords(transcriptPath);
      expect(computeClearBoundarySeq(records)).toBe(2);
      // ...and it agrees with the body: every projected row is ABOVE it.
      for (const r of projectDisplayRecords(records)) {
        expect(r.seq as number).toBeGreaterThan(2);
      }
    });

    it('follows the LAST clear when a session is cleared more than once', () => {
      triologue.user('q1');
      triologue.clear(); // seq 2
      triologue.user('q2'); // seq 3
      triologue.clear(); // seq 4 — this is now the boundary
      expect(computeClearBoundarySeq(readTranscriptRecords(transcriptPath))).toBe(4);
    });

    it('agrees with the projection on an empty/absent transcript (both empty, boundary 0)', () => {
      const records = readTranscriptRecords(path.join(tmpDir, 'does-not-exist.jsonl'));
      expect(records).toHaveLength(0);
      expect(computeClearBoundarySeq(records)).toBe(0);
    });
  });
});
