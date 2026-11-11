/**
 * display-record-seam.test.ts - the ONE-record-stream contract (S2c)
 *
 * The duplicate-card defect came from two sources overlapping by type: the
 * printer pushed a line to the socket AND /history replayed the same turn from
 * the transcript. The fix is to make the socket a projection of the JOURNAL,
 * not a parallel push. This file pins the three properties that make that true,
 * so a future edit cannot quietly re-introduce a second copy:
 *
 *   1. Every durable record fires the display observer exactly once, with the
 *      same `seq` the file carries (the identity the client dedupes on).
 *   2. Boundary records (clear/compact/rollback/segment-archive) and `merge`
 *      fragments are NOT forwarded — they are journal marks, not chat rows.
 *   3. A failed append forwards nothing (the record is not durable, so there is
 *      nothing to render and `seq` is not consumed).
 *
 * The projection rule itself (record -> LogEntry) is covered by
 * serve-history.test.ts via projectDisplay; this file covers the notify seam
 * that replaced the second push.
 */
import { describe, it, expect } from 'vite-plus/test';
import { JsonlTranscriptWriter, memoryLineSink, type TranscriptRecord } from '../../loop/triologue/transcript.js';

function makeWriter() {
  const sink = memoryLineSink();
  const writer = new JsonlTranscriptWriter(sink);
  const seen: TranscriptRecord[] = [];
  writer.setDisplayObserver((record) => seen.push(record));
  return { sink, writer, seen };
}

describe('JsonlTranscriptWriter display observer (the live-socket seam)', () => {
  it('forwards ONE record per journaled note, carrying the seq written to the file', () => {
    const { sink, writer, seen } = makeWriter();

    writer.note({ level: 'info', tool: 'bash', text: 'listed 3 files', at: '13:30:42' });

    expect(seen).toHaveLength(1);
    expect(seen[0].kind).toBe('note');
    // The SAME number lives in the journal line — that equality is what lets a
    // reconnecting client tell "already rendered" from "missed while offline".
    const onDisk = JSON.parse(sink.lines[0]) as TranscriptRecord;
    expect(seen[0].seq).toBe(onDisk.seq);
    expect(seen[0].seq).toBe(1);
  });

  it('forwards message pieces too, so replies land on the socket without a second push', () => {
    const { writer, seen } = makeWriter();

    writer.append({ role: 'assistant', content: 'done', kind: 'new' } as never);
    writer.append({ role: 'user', content: 'next', kind: 'user', user_origin: true } as never);

    expect(seen.map((r) => r.seq)).toEqual([1, 2]);
    expect(seen.map((r) => r.kind)).toEqual(['new', 'user']);
  });

  it('does NOT forward boundary records or merge fragments (journal marks, not chat rows)', () => {
    const { writer, seen } = makeWriter();

    writer.control('clear');
    writer.append({ role: 'user', content: '[HINT] injected', kind: 'merge' } as never);
    writer.control('compact');
    writer.note({ level: 'info', tool: 'brief', text: 'a real row', at: '13:30:43' });

    expect(seen).toHaveLength(1);
    expect(seen[0].kind).toBe('note');
    // Boundary marks still consumed their sequence numbers — the cursor stays
    // monotonic even for records the display layer skips.
    expect(seen[0].seq).toBe(4);
  });

  it('forwards nothing when the append fails, and does not consume the seq', () => {
    const throwingSink = {
      destination: '<throwing>',
      append(): void {
        throw new Error('disk full');
      }
    };
    const writer = new JsonlTranscriptWriter(throwingSink);
    const seen: TranscriptRecord[] = [];
    writer.setDisplayObserver((record) => seen.push(record));

    expect(writer.note({ level: 'error', tool: 'tool', text: 'boom', at: '13:30:44' })).toBe(false);
    expect(seen).toEqual([]);
    // The failed record never existed, so its number is still available.
    expect(writer.sequence).toBe(1);
  });

  it('a throwing observer never breaks the writer (the never-throws contract)', () => {
    const sink = memoryLineSink();
    const writer = new JsonlTranscriptWriter(sink);
    writer.setDisplayObserver(() => {
      throw new Error('observer exploded');
    });

    expect(writer.note({ level: 'info', tool: 'brief', text: 'still written', at: '13:30:45' })).toBe(true);
    expect(sink.lines).toHaveLength(1);
  });

  it('setDisplayObserver(null) detaches, so a restart re-subscribes exactly once', () => {
    const { writer, seen } = makeWriter();

    writer.setDisplayObserver(null);
    writer.setDisplayObserver((record) => seen.push(record));
    writer.note({ level: 'info', tool: 'brief', text: 'once', at: '13:30:46' });

    expect(seen).toHaveLength(1);
  });
});
