/**
 * serve-history-invariant.test.ts — PRODUCER-LEVEL integration guard for PR #26
 *
 * The unit suites (serve-history.test.ts, transcript.test.ts) exercise the
 * collation records synthetically. This suite closes the P2 gap: it drives the
 * REAL producer seams — `Triologue.user()` / `.note()` and
 * `ServeHub.pushSteer()` — through the actual provider wiring
 * (`setUserJournalProvider` → `submitUser` → `emit` → `onMessage` →
 * `JsonlTranscriptWriter`), then reads the result back through `readHistory`.
 *
 * The invariant under test (the whole point of the PR):
 *   every REAL typed submission produces exactly ONE WebUI user bubble,
 *   while NO injected note does.
 *
 * It is deliberately end-to-end-ish so a silently disconnected seam (the exact
 * failure mode the unit tests can miss, because each layer passes its own
 * isolated test) makes this suite fail.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Triologue } from '../../loop/triologue.js';
import { ServeHub } from '../../serve/serve-hub.js';
import { JsonlTranscriptWriter, collateMessages, readTranscript } from '../../loop/triologue/transcript.js';
import { getSteeringManager } from '../../loop/steering-manager.js';
import { readHistory } from '../../serve/serve-history.js';
import type { Message } from '../../types.js';

describe('PR #26 invariant: real submissions → one bubble each; no note renders', () => {
  let tmpDir: string;
  let transcriptPath: string;
  let writer: JsonlTranscriptWriter;
  let triologue: Triologue;
  let hub: ServeHub;
  const unsubscribers: Array<() => void> = [];

  beforeEach(() => {
    // The steering manager is a PROCESS-WIDE singleton shared with every other
    // suite in this worker: a queue or delivery mark left behind by a previous
    // test would be read here (and vice versa). Reset it before each case.
    getSteeringManager().clear('test-reset');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-invariant-'));
    transcriptPath = path.join(tmpDir, 'transcript.jsonl');

    // The single writer — exactly as agent-repl constructs it.
    writer = new JsonlTranscriptWriter(transcriptPath);

    // The real Triologue, wired so every emitted piece hits the writer
    // (this mirrors agent-repl's onMessage → writer.append path).
    triologue = new Triologue({
      onMessage: (msg: Message) => {
        const { role, content, ...extra } = msg as Message & Record<string, unknown>;
        writer.append({
          role,
          content,
          ...extra
        } as unknown as Parameters<typeof writer.append>[0]);
      },
      tokenThreshold: 50000,
      resultThreshold: 100000
    });

    // The real ServeHub, wired to the Triologue via the provider seam — the
    // SAME seam agent-repl registers. If this wiring is broken the invariant
    // test fails.
    hub = new ServeHub();
    hub.setTranscriptPath(transcriptPath);
    // Mirror agent-repl (wireOutputMirroring): the writer's display stream must
    // reach the hub, because `broadcastDisplayRecord` is the ONLY honest proof
    // that a journal write landed (it runs below append()'s sink success).
    // Without this subscription `pushSteer` cannot tell a durable row from a
    // swallowed provider throw and always reports `false`.
    const detach = () => writer.setDisplayObserver(null);
    writer.setDisplayObserver((record) => hub.broadcastDisplayRecord(record));
    unsubscribers.push(detach);
    hub.setUserJournalProvider((text, source) => triologue.submitUser(text, source));
  });

  afterEach(() => {
    for (const off of unsubscribers.splice(0)) off();
    getSteeringManager().clear('test-teardown');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('two real submissions → exactly two user bubbles (and no note bubble)', () => {
    // 1. A real typed query (prompt submission).
    triologue.submitUser('first real query', 'prompt');
    // 2. An injected system note — MUST NOT become a bubble.
    triologue.note('REMINDER', 'auto nudging note');
    // 3. A second real typed query, arriving as a user() append + combine.
    //    NOTE: the serve projection (collateEntries) is a CLEAN SCAN — it does
    //    NOT fold the combine fragment, so a combine yields TWO bubbles
    //    ('second' then 'query'), each a genuine typed submission. (The
    //    restoration projection collateMessages folds them instead.)
    triologue.user('second');
    triologue.user('query'); // combine branch → kind:'user'
    // 4. A steering note typed in the browser → journaled via the hub.
    hub.pushSteer('please stop and reconsider');

    const history = readHistory(transcriptPath, []);
    const userBubbles = history.filter((e) => e.type === 'user');
    const contents = userBubbles.map((e) => e.content);

    // Exactly the genuine submissions, each exactly once (the combine
    // fragment is its own bubble in the serve view).
    expect(contents).toContain('first real query');
    expect(contents).toContain('second');
    expect(contents).toContain('query');
    expect(contents).toContain('please stop and reconsider');
    // The injected note never renders as user input.
    expect(contents.some((c) => c.includes('auto nudging note'))).toBe(false);
    expect(contents.some((c) => c.includes('[REMINDER]'))).toBe(false);
    expect(userBubbles).toHaveLength(4);
  });

  it('the hub is the ONLY route for a steer: no provider → no bubble', () => {
    // With no provider registered (serve started before the loop wired it),
    // a pushSteer is a silent no-op — it must NOT throw and must NOT invent a
    // bubble from nowhere.
    const unboundHub = new ServeHub();
    unboundHub.setTranscriptPath(transcriptPath);
    expect(() => unboundHub.pushSteer('orphan steer')).not.toThrow();
    expect(readHistory(transcriptPath, []).filter((e) => e.type === 'user')).toHaveLength(0);
  });

  it('a marker-less injected user piece never renders (anti-smuggling)', () => {
    // A raw 'new' user record with NO user_origin marker (as an injected
    // [HINT] would appear if it leaked into the journal as a plain append).
    writer.append({ role: 'user', content: '[HINT] leaked note', kind: 'new' } as unknown as Parameters<
      typeof writer.append
    >[0]);
    // And a legitimate submission for contrast.
    triologue.submitUser('legitimate', 'prompt');
    const userBubbles = readHistory(transcriptPath, []).filter((e) => e.type === 'user');
    expect(userBubbles.map((e) => e.content)).toEqual(['legitimate']);
  });

  it('a steer DELIVERED as the next query yields exactly ONE bubble', async () => {
    // The defect this suite exists to pin: the note is journaled at submission
    // (kind:'steer' → a bubble) and, when it misses the COLLECT drain, is later
    // delivered as the turn's query — which PROMPT journals too. Without the
    // steer_delivery marker the user sees the same text twice.
    //
    // Driving the REAL seams: park a PROMPT wait, push the steer (journaled and
    // held), then let the delivery resolve the wait. Provenance is armed only
    // when a resolver actually fires — that IS the contract.
    const pending = hub.waitForInput();
    const journaled = hub.pushSteer('tighten the loop');
    expect(journaled).toBe(true); // the submission row is durable

    const delivered = await pending;
    expect(delivered.fromSteering).toBe(true);
    expect(delivered.text).toBe('tighten the loop');

    // PROMPT consumes the marks and journals the delivery as the query.
    const marks = getSteeringManager().takeDelivered();
    expect(marks.delivered).toBe(1);
    expect(marks.journaled).toBe(1);
    expect(marks.text).toBe('tighten the loop');
    triologue.user(marks.text, { steerDelivery: true });

    const history = readHistory(transcriptPath, []);
    const steerBubbles = history.filter((e) => e.type === 'user' && e.content === 'tighten the loop');
    expect(steerBubbles).toHaveLength(1);

    // …and the delivered text is STILL in the restoration projection: it is the
    // instruction the model was asked to act on, and a /load must replay it.
    const records = readTranscript(transcriptPath).records;
    const collated = collateMessages(records).filter((m) => m.role === 'user');
    expect(collated.some((m) => m.content === 'tighten the loop')).toBe(true);
    // …without leaking the display marker into the provider payload.
    expect(collated.every((m) => (m as Record<string, unknown>).steer_delivery === undefined)).toBe(true);
  });

  it('a delivery whose submission row did NOT land stays visible (fail open)', async () => {
    // The same wiring minus a registered provider: pushSteer queues the note but
    // journals nothing, so the submission row does not exist. Suppressing the
    // delivery row here would leave ZERO bubbles — the guard must fail open.
    const bareHub = new ServeHub();
    bareHub.setTranscriptPath(transcriptPath);
    const pending = bareHub.waitForInput();
    const journaled = bareHub.pushSteer('no journal backing');
    expect(journaled).toBe(false);

    await pending;
    const marks = getSteeringManager().takeDelivered();
    expect(marks.delivered).toBe(1);
    expect(marks.journaled).toBe(0);
    // PROMPT's flag is `delivered && journaled === delivered`, so this journals
    // an ordinary query and the bubble survives.
    triologue.user(marks.text, { steerDelivery: false });

    const userBubbles = readHistory(transcriptPath, []).filter((e) => e.type === 'user');
    expect(userBubbles).toHaveLength(1);
    expect(userBubbles[0].content).toBe('no journal backing');
  });

  it('a steer delivered with NO parked wait journals nothing (and arms no mark)', () => {
    // resolveSteering drains the queue unconditionally, but submitInput only
    // records provenance when it really resolves a wait. Arming a mark on the
    // drop path would strand it and later suppress a genuine query's bubble.
    hub.pushSteer('dropped note');
    hub.submitInput('dropped note', {
      fromSteering: true,
      notes: [{ id: 1, text: 'dropped note', journaled: true }]
    });

    const marks = getSteeringManager().takeDelivered();
    expect(marks.delivered).toBe(0);

    // The submission bubble is the only trace, as today.
    const userBubbles = readHistory(transcriptPath, []).filter((e) => e.type === 'user');
    expect(userBubbles.map((e) => e.content)).toEqual(['dropped note']);
  });
});
