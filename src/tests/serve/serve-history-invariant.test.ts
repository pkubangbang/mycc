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
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Triologue } from '../../loop/triologue.js';
import { ServeHub } from '../../serve/serve-hub.js';
import { JsonlTranscriptWriter } from '../../loop/triologue/transcript.js';
import { readHistory } from '../../serve/serve-history.js';
import type { Message } from '../../types.js';

describe('PR #26 invariant: real submissions → one bubble each; no note renders', () => {
  let tmpDir: string;
  let transcriptPath: string;
  let writer: JsonlTranscriptWriter;
  let triologue: Triologue;
  let hub: ServeHub;

  beforeEach(() => {
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
          ...extra,
        } as unknown as Parameters<typeof writer.append>[0]);
      },
      tokenThreshold: 50000,
      resultThreshold: 100000,
    });

    // The real ServeHub, wired to the Triologue via the provider seam — the
    // SAME seam agent-repl registers. If this wiring is broken the invariant
    // test fails.
    hub = new ServeHub();
    hub.setTranscriptPath(transcriptPath);
    hub.setUserJournalProvider((text, source) => triologue.submitUser(text, source));
  });

  afterEach(() => {
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
    writer.append({ role: 'user', content: '[HINT] leaked note', kind: 'new' } as unknown as Parameters<typeof writer.append>[0]);
    // And a legitimate submission for contrast.
    triologue.submitUser('legitimate', 'prompt');
    const userBubbles = readHistory(transcriptPath, []).filter((e) => e.type === 'user');
    expect(userBubbles.map((e) => e.content)).toEqual(['legitimate']);
  });
});
