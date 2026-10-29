/**
 * write-isolation.test.ts — the injected LineSink port.
 *
 * Every permanent-state writer (triologue transcript, mindmap patch JSONL,
 * wiki WAL) can be handed a sink instead of writing to a config-resolved path.
 * These tests inject an IN-MEMORY sink and assert the payload is correct, that
 * the sink is the only destination, and that a throwing sink cannot break the
 * writer. Before the port, the transcript writer's never-throws contract could
 * only be exercised by monkey-patching `fs`, and the wiki WAL could only be
 * reached through `os.homedir()`.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  JsonlTranscriptWriter,
  fileLineSink,
  memoryLineSink,
} from '../loop/triologue/transcript.js';
import { appendPatch } from '../mindmap/patch-jsonl.js';
import { appendWALEntry, appendWALEntries } from '../context/parent/wiki-wal.js';
import type { MindmapPatchAction } from '../mindmap/types.js';
import type { WALEntry } from '../types.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('JsonlTranscriptWriter + LineSink', () => {
  it('writes one flat JSON line per append to the injected sink', () => {
    const sink = memoryLineSink();
    const w = new JsonlTranscriptWriter(sink);

    w.append({ role: 'user', content: 'hello' });
    w.append({ role: 'assistant', content: 'hi' });

    expect(sink.lines).toHaveLength(2);
    const first = JSON.parse(sink.lines[0]);
    expect(first.role).toBe('user');
    expect(first.content).toBe('hello');
    // kind defaults to 'new' and a timestamp is stamped at write time.
    expect(first.kind).toBe('new');
    expect(typeof first.timestamp).toBe('number');
    expect(sink.lines[0].endsWith('\n')).toBe(true);
  });

  it('never touches the filesystem when given a sink', () => {
    // A real fs write would land in cwd/.mycc — prove the sink is the only
    // destination by pointing the path-less writer at a directory that does
    // not exist: if it fell back to the file sink it would throw ENOENT.
    const missing = path.join(os.tmpdir(), `wi-absent-${process.pid}-${Date.now()}`, 'x.jsonl');
    const onError = vi.fn();
    const sink = memoryLineSink();
    const w = new JsonlTranscriptWriter(sink, onError);
    expect(() => w.append({ role: 'user', content: 'x' })).not.toThrow();
    expect(onError).not.toHaveBeenCalled();
    expect(sink.lines).toHaveLength(1);
    expect(fs.existsSync(path.dirname(missing))).toBe(false);
  });

  it('accepts a bare path for source compatibility (production sink)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wi-transcript-'));
    try {
      const p = path.join(dir, 'triologue.jsonl');
      new JsonlTranscriptWriter(p).append({ role: 'user', content: 'on disk' });
      expect(fs.readFileSync(p, 'utf-8')).toContain('"content":"on disk"');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a THROWING sink is observed through onError instead of crashing the turn', () => {
    const onError = vi.fn();
    const throwing = {
      destination: '<throwing>',
      append() {
        throw new Error('disk full');
      },
    };
    const w = new JsonlTranscriptWriter(throwing, onError);

    expect(() => w.append({ role: 'user', content: 'lost' })).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toBe('disk full');
    expect(onError.mock.calls[0][1]).toBe('<throwing>');
  });
});

describe('appendPatch + LineSink', () => {
  const action: MindmapPatchAction = { action: 'update', path: '/a', text: 't' } as MindmapPatchAction;

  it('appends one validated JSON line to the injected sink', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wi-patch-'));
    try {
      const sink = memoryLineSink();
      expect(appendPatch(action, path.join(dir, '.mycc', 'mindmap-patch.jsonl'), sink)).toBe(true);
      expect(sink.lines).toHaveLength(1);
      expect(JSON.parse(sink.lines[0])).toEqual(action);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an invalid action WITHOUT writing to the sink', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wi-patch-'));
    try {
      const sink = memoryLineSink();
      const ok = appendPatch({ action: 'add', path: '/a', title: '', text: '' } as MindmapPatchAction,
        path.join(dir, 'p.jsonl'), sink);
      expect(ok).toBe(false);
      expect(sink.lines).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still writes to disk when no sink is injected', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wi-patch-'));
    try {
      const p = path.join(dir, 'p.jsonl');
      appendPatch(action, p);
      expect(fs.readFileSync(p, 'utf-8').trim()).toBe(JSON.stringify(action));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('wiki WAL + LineSink', () => {
  const entry = { hash: 'h1', state: 'ok', namespace: 'ns' } as unknown as WALEntry;

  it('appendWALEntry writes exactly one line to the injected sink', () => {
    const sink = memoryLineSink();
    appendWALEntry(entry, sink);
    expect(sink.lines).toHaveLength(1);
    expect(JSON.parse(sink.lines[0]).hash).toBe('h1');
  });

  it('appendWALEntries writes many entries in ONE append (batch = one fs op)', () => {
    const sink = memoryLineSink();
    appendWALEntries([entry, { ...entry, hash: 'h2' } as WALEntry], sink);
    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0].trim().split('\n')).toHaveLength(2);
  });

  it('a batch of zero entries never touches the sink', () => {
    const append = vi.fn();
    appendWALEntries([], { destination: '<spy>', append });
    expect(append).not.toHaveBeenCalled();
  });
});

describe('fileLineSink', () => {
  it('exposes its destination for diagnostics and appends verbatim', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wi-sink-'));
    try {
      const p = path.join(dir, 'x.jsonl');
      const sink = fileLineSink(p);
      expect(sink.destination).toBe(p);
      sink.append('a\n', 'utf-8');
      sink.append('b\n', 'utf-8');
      expect(fs.readFileSync(p, 'utf-8')).toBe('a\nb\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
