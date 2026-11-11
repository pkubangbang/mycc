/**
 * card-journal-roundtrip.test.ts - a pending CARD must survive a reload (P0-2)
 *
 * THE DEFECT THIS FILE EXISTS FOR:
 *   `broadcastCard()` pushed the card into the in-memory `messageLog` and sent
 *   it to every open socket. After /history became a projection of the
 *   transcript journal, that log copy stopped being read — so a refresh while
 *   the agent was blocked in `waitForCardResponse()` showed NO widget while the
 *   server kept waiting for an answer nobody could see. The agent hung, visibly
 *   in the terminal and invisibly in the browser.
 *
 * The fix journals the card as a display NOTE carrying its payload, and
 * `projectDisplayRecord` rebuilds a `type:'card'` row from it. This file wires
 * the REAL ServeHub to the REAL JsonlTranscriptWriter through the REAL seam
 * agent-repl registers, and asserts on the FILE and on the projected row — not
 * on the hub's memory, because the memory is exactly what does not survive.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ServeHub } from '../../serve/serve-hub.js';
import { JsonlTranscriptWriter, readTranscript } from '../../loop/triologue/transcript.js';
import { projectDisplay, readHistory } from '../../serve/serve-history.js';
import type { CardMessage } from '../../serve/serve-types.js';

const CARD: CardMessage = {
  type: 'card',
  cardId: 'c-42',
  query: 'Overwrite src/index.ts?',
  kind: 'confirm',
  options: [
    { label: 'Yes', value: 'yes', isDefault: true },
    { label: 'No', value: 'no', isDefault: false }
  ],
  placeholder: 'type yes or no'
};

describe('broadcastCard -> journal note -> /history card row (P0-2)', () => {
  let tmpDir: string;
  let transcriptPath: string;
  let writer: JsonlTranscriptWriter;
  let hub: ServeHub;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-journal-'));
    transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    writer = new JsonlTranscriptWriter(transcriptPath);
    hub = new ServeHub();
    hub.setTranscriptPath(transcriptPath);
    // The SAME two bindings agent-repl performs in onServeHubReady.
    hub.setDisplayWriter(writer);
    hub.setCardJournal((card) =>
      writer.note({
        level: 'info',
        tool: 'card',
        text: card.query,
        at: new Date().toISOString(),
        card
      })
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes the card to the DURABLE journal (messageLog alone was the bug)', () => {
    hub.broadcastCard(CARD);

    const { records } = readTranscript(transcriptPath);
    expect(records).toHaveLength(1);
    expect(records[0].kind).toBe('note');
    expect((records[0] as { note?: { card?: unknown } }).note?.card).toMatchObject({ cardId: 'c-42', kind: 'confirm' });
    expect(records[0].seq).toBe(1);
  });

  it('the journaled card PROJECTS to a card row after a reload', () => {
    hub.broadcastCard(CARD);

    // A reload is readHistory over the file — the messageLog is deliberately
    // empty here, proving the row does not depend on serve-lifetime memory.
    const history = readHistory(transcriptPath, []);
    expect(history).toHaveLength(1);
    expect(history[0].type).toBe('card');
    expect(history[0].card?.cardId).toBe('c-42');
    expect(history[0].card?.query).toBe('Overwrite src/index.ts?');
    expect(history[0].card?.kind).toBe('confirm');
    expect(history[0].card?.options).toEqual(CARD.options);
    expect(history[0].card?.placeholder).toBe('type yes or no');
  });

  it('preserves option ORDER — the default option is the one Enter picks', () => {
    hub.broadcastCard(CARD);
    const row = projectDisplay(transcriptPath)[0];
    expect(row.card?.options?.map((o) => o.value)).toEqual(['yes', 'no']);
    expect(row.card?.options?.[0].isDefault).toBe(true);
  });

  it('a replayed card is ONE row, not one per reload', () => {
    hub.broadcastCard(CARD);
    expect(projectDisplay(transcriptPath)).toHaveLength(1);
    expect(projectDisplay(transcriptPath)).toHaveLength(1);
  });

  it('strips ANSI from the card body but keeps the structured values intact', () => {
    hub.broadcastCard({ ...CARD, query: '\u001b[31mDanger\u001b[0m proceed?' });
    const row = projectDisplay(transcriptPath)[0];
    expect(row.content).toBe('Danger proceed?');
    expect(row.card?.query).toBe('Danger proceed?');
    expect(row.card?.options?.[0].value).toBe('yes');
  });

  it('an unbound journal (teammate worker, no writer) does not throw', () => {
    const bare = new ServeHub();
    bare.setTranscriptPath(transcriptPath);
    expect(() => bare.broadcastCard(CARD)).not.toThrow();
  });

  it('reaches the socket EXACTLY ONCE — the journaled row is the single live copy', () => {
    // THE DEFECT THIS PINS (round 2, both reviewers, independently):
    // broadcastCard() journals AND sent the flat payload, so the client got the
    // card twice: once projected through the journal (nested `card`, carrying the
    // `seq`) and once flat. Two widgets for one question, and the projected copy
    // used to render with cardId '' — inert buttons — until message-dispatch
    // learned to read msg.card?.cardId.
    //
    // THE INVARIANT PINNED HERE: the journaled projection is the ONE live copy
    // when a journal is bound; the flat send is the no-journal fallback only.
    // ONE OWNER, not two senders that happen to agree.
    //
    // The observer subscription is NOT optional in this fixture: setDisplayWriter
    // only STORES the writer, the subscription lives in wireOutputMirroring
    // (activate.ts). Without this line the journal path never fires and the test
    // passes for the opposite reason its name states — the vacuous shape this
    // work item has now shipped twice.
    const frames: string[] = [];
    const fakeWs = {
      readyState: 1, // WebSocket.OPEN
      send: (p: string) => frames.push(p),
      close: () => {},
      on: () => {}
    };
    (hub as unknown as { clients: { add(ws: unknown): void } }).clients.add(fakeWs);
    writer.setDisplayObserver((record) => hub.broadcastDisplayRecord(record));

    hub.broadcastCard(CARD);

    expect(frames).toHaveLength(1);
    const frame = JSON.parse(frames[0]) as {
      type: string;
      content?: string;
      seq?: number;
      cardId?: string;
      card?: { cardId?: string; query?: string; kind?: string };
    };
    expect(frame.type).toBe('card');
    // IDENTITY SURVIVES THE WIRE — whichever shape arrives, the client must be
    // able to name the card it is answering. message-dispatch reads
    // `msg.cardId ?? msg.card?.cardId`.
    expect(frame.cardId ?? frame.card?.cardId).toBe('c-42');
    // The journaled row carries the seq that makes a live card and its /history
    // row the same identity.
    expect(frame.seq).toBe(1);
    // And the journal write still happened: durability and single-send are not a
    // trade-off.
    expect(projectDisplay(transcriptPath)).toHaveLength(1);
  });
});

/**
 * Console lines are NOT journaled — the rule, and the reason.
 *
 * An earlier slice of this work journaled every log/warn/error line as a durable
 * note so it would survive a reload. Both round-2 reviewers rejected that and they
 * are right: raw console output is the ONE class with no user-facing loss when it
 * stays out of the journal, because the TERMINAL is already its record. Journaling
 * it grew the transcript on every verbose tick and made /history re-parse and
 * re-serialise that growth on every GET (projectDisplay applies no cap).
 *
 * These tests pin the rule in BOTH directions: console lines must NOT reach the
 * file, and brief() lines MUST — so a future edit cannot quietly restore the growth
 * by re-routing log() into the sink.
 */
describe('console lines stay out of the durable journal (round-2 rule)', () => {
  let tmpDir: string;
  let transcriptPath: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-journal-'));
    transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    const { agentIO } = await import('../../loop/agent-io.js');
    const writer = new JsonlTranscriptWriter(transcriptPath);
    agentIO.setDisplayNoteSink((note) => writer.note(note));
    (agentIO as unknown as { outputBuffer: unknown[] }).outputBuffer = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    const { agentIO } = await import('../../loop/agent-io.js');
    agentIO.setDisplayNoteSink(null);
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does NOT journal log/warn/error (they are terminal-only)', async () => {
    const { agentIO } = await import('../../loop/agent-io.js');
    agentIO.log('a raw verbose line');
    agentIO.warn('careful');
    agentIO.error('broke');
    const { records } = readTranscript(transcriptPath);
    expect(records).toHaveLength(0);
    expect(projectDisplay(transcriptPath)).toEqual([]);
  });

  it('verbose() does not journal either (a -v session must not grow the file)', async () => {
    const { agentIO } = await import('../../loop/agent-io.js');
    agentIO.verbose('bash', 'tool args');
    expect(readTranscript(transcriptPath).records).toHaveLength(0);
  });

  it('STILL journals brief() lines — the agent narrative is what a reload is for', async () => {
    const { agentIO } = await import('../../loop/agent-io.js');
    agentIO.brief('info', 'bash', 'listed 3 files');
    const notes = readTranscript(transcriptPath).records.filter((r) => r.kind === 'note');
    expect(notes).toHaveLength(1);
    expect(notes[0].note).toMatchObject({ tool: 'bash', text: 'listed 3 files' });
  });
});
