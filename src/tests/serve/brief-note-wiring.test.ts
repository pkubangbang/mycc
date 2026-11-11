/**
 * brief-note-wiring.test.ts - the seam that three reviewers found unwired
 *
 * THE DEFECT THIS FILE EXISTS FOR:
 *   `display-record-seam.test.ts` proved the writer notifies an observer, and
 *   `serve-history.test.ts` proved the projection renders a note — but nothing
 *   proved brief() ever CALLS the writer. So when the emitter was lost from
 *   agent-io.ts, every test still passed while the WebUI silently lost every
 *   status line. That is the failure mode this file closes: it wires the REAL
 *   AgentIO to the REAL JsonlTranscriptWriter and asserts on the FILE.
 *
 * Rule of thumb it encodes: test the seam, not just the two sides of it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../utils/line-editor.js', () => ({
  LineEditor: vi.fn().mockImplementation(() => ({
    handleKey: vi.fn(),
    resize: vi.fn(),
    getHistory: vi.fn().mockReturnValue([]),
    close: vi.fn()
  }))
}));

import { agentIO } from '../../loop/agent-io.js';
import { JsonlTranscriptWriter, readTranscript } from '../../loop/triologue/transcript.js';
import { projectDisplay } from '../../serve/serve-history.js';

describe('agentIO.brief() -> transcript note -> /history row (the unwired seam)', () => {
  let tmpDir: string;
  let transcriptPath: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-note-wiring-'));
    transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    (agentIO as unknown as { outputBuffer: unknown[] }).outputBuffer = [];
    (agentIO as unknown as { activeLineEditor: unknown }).activeLineEditor = null;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    agentIO.setDisplayNoteSink(null); // never leak a sink into another test
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes exactly ONE note record per brief() call', () => {
    const writer = new JsonlTranscriptWriter(transcriptPath);
    agentIO.setDisplayNoteSink((note) => writer.note(note));

    agentIO.brief('info', 'bash', 'listed 3 files');

    const { records } = readTranscript(transcriptPath);
    const notes = records.filter((r) => r.kind === 'note');
    // Exactly one: the nested log() call inside brief() must NOT produce a
    // second (the mirror tri-state exists for that reason).
    expect(notes).toHaveLength(1);
    expect(notes[0].note).toMatchObject({ level: 'info', tool: 'bash', text: 'listed 3 files' });
    expect(notes[0].seq).toBe(1);
    expect(logSpy).toHaveBeenCalled(); // the terminal still printed it
  });

  it('the journaled note PROJECTS to a /history row (the whole point)', () => {
    const writer = new JsonlTranscriptWriter(transcriptPath);
    agentIO.setDisplayNoteSink((note) => writer.note(note));

    agentIO.brief('warn', 'tool', 'segment failed', 'RETRY segment', {
      crossroad: {
        kind: 'crossroad',
        drafted: 1,
        chosenIndex: 1,
        candidates: [{ index: 1, direction: 'go forward', preview: 'seg', selected: true }],
        outcome: 'seg',
        cutpoint: ''
      }
    });

    const rows = projectDisplay(transcriptPath);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'warn',
      label: 'tool',
      content: 'segment failed',
      detail: 'RETRY segment',
      seq: 1
    });
    expect(rows[0].crossroad).toEqual({
      kind: 'crossroad',
      drafted: 1,
      chosenIndex: 1,
      candidates: [{ index: 1, direction: 'go forward', preview: 'seg', selected: true }],
      outcome: 'seg',
      cutpoint: ''
    });
  });

  it('carries `synthetic` through, so machine briefs are hidden in BOTH sinks', () => {
    // Regression for `void opts`: the flag was dropped, so hook-engine briefs
    // would have appeared in the chat log.
    const writer = new JsonlTranscriptWriter(transcriptPath);
    agentIO.setDisplayNoteSink((note) => writer.note(note));

    agentIO.brief('info', 'hook', 'machine noise', undefined, { synthetic: true });

    const { records } = readTranscript(transcriptPath);
    expect(records[0].note).toMatchObject({ synthetic: true });
    // Recorded (the terminal printed it) but NOT a chat row.
    expect(projectDisplay(transcriptPath)).toEqual([]);
  });

  it('a full round trip: note + assistant piece land in ONE stream, in order', () => {
    const writer = new JsonlTranscriptWriter(transcriptPath);
    agentIO.setDisplayNoteSink((note) => writer.note(note));

    agentIO.brief('info', 'bash', 'running tests');
    writer.append({ role: 'assistant', content: 'all green', kind: 'new' } as never);

    const rows = projectDisplay(transcriptPath);
    expect(rows.map((r) => [r.type, r.content])).toEqual([
      ['log', 'running tests'],
      ['result', 'all green']
    ]);
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
  });

  it('detaching the sink stops journaling (no silent double-sink after restart)', () => {
    const writer = new JsonlTranscriptWriter(transcriptPath);
    agentIO.setDisplayNoteSink((note) => writer.note(note));
    agentIO.brief('info', 'brief', 'one');
    agentIO.setDisplayNoteSink(null);
    agentIO.brief('info', 'brief', 'two');

    const notes = readTranscript(transcriptPath).records.filter((r) => r.kind === 'note');
    expect(notes).toHaveLength(1);
  });
});
