/**
 * serve-upload-teardown.test.ts — the file-upload queue's TEARDOWN and
 * messageLog wiring (review fix #3).
 *
 * TWO DEFECTS, both introduced when the upload queue moved out of serve-hub.ts
 * into serve-queues.ts:
 *
 * (A) THE BUFFER WAS NEVER FLUSHED ON TEARDOWN. HEAD's `stop()` did
 *     `this.fileUploadQueue = []`; the extracted state machine has no
 *     equivalent and `FileUploadQueue.reset()` had ZERO callers (the hub field
 *     is `readonly`, so the old assignment form is gone). Consequence: a file
 *     attached just before a stop / WebUI restart stays buffered and is drained
 *     into the FIRST turn of the NEXT session.
 *
 * (B) THE UPLOAD FRAMES BYPASSED THE messageLog. HEAD always routed them
 *     through `hub.broadcast()`, which supplies the message log; the extracted
 *     `FileUploadQueue` called `clients.broadcast()` WITHOUT it. Consequence:
 *     the `file-upload` / `file-flush` rows and the oversized-upload rejection
 *     never entered `messageLog`, so `/history`'s no-transcript fallback (the
 *     hub serves `messageLog` verbatim when the transcript holds no records)
 *     and `dumpSnapshot().messageLogLength` / `historyRows` silently lost them.
 *     The rejection notice disappears on reload — that is the user-visible bug.
 *
 * WHY THE LOG IS PASSED AS A THUNK (`() => MessageLogHolder`), NOT AS AN ARRAY:
 * the hub REASSIGNS `messageLog` (`this.messageLog = []`) on every start, every
 * stop and every `/clear` boundary — see `resetMessageLog()` and
 * `clearDisplayedHistory()`. A captured array would therefore be the STALE
 * object: those rows would land in a log nothing reads any more, and the test
 * below that re-points the field would catch exactly that. The thunk is what
 * makes the frame reach the CURRENT log, which is the one the `/history`
 * fallback serves and the one `dumpSnapshot` measures.
 *
 * THE IDENTITY CLAIM IS THE POINT (lead's third element): "a broadcast
 * happened" is not enough. A broadcast into a DIFFERENT log object would pass a
 * naive spy and still lose the row, so these tests assert (i) the row is IN the
 * array object the hub's own readers measure, and (ii) after the hub reassigns
 * its field the very next row lands in the NEW array, not the old one.
 *
 * The two small FOLD-INS from the same review are pinned here too:
 *   - gracefulShutdown()'s print-then-abort tail must run even when the
 *     teardown throws (or output/result mirroring stays wired to a disposed
 *     stack and the terminal wait is never unblocked);
 *   - start()'s failure path must tear down the steering observer it armed
 *     (otherwise a failed start leaks one observer until the next success).
 *
 * These tests drive a REAL ServeHub with no port bound: `disposeStack()` is a
 * no-op when no stack was mounted, so the lifecycle transitions, the queues and
 * the diagnostics snapshot are all the genuine article.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';
import { ServeHub } from '../../serve/serve-hub.js';
import { FileUploadQueue } from '../../serve/serve-queues.js';
import { getSteeringManager } from '../../loop/steering-manager.js';
import { setWebUiUp } from '../../loop/loop-events.js';
import type { LogEntry, FileUploadEntry } from '../../serve/serve-types.js';

// A tiny upload cap so the oversized-rejection path can be driven with a short
// payload instead of a 50 MB base64 blob. Only `getMaxUploadMb` is replaced;
// everything else in config.js (notably `shouldDaemon`) stays real.
vi.mock('../../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config.js')>();
  return { ...actual, getMaxUploadMb: () => 0.0001 };
});

/** Cast-away-privacy view of the hub internals these tests inspect. */
type HubInternals = {
  messageLog: LogEntry[];
  fileUploadQueue: FileUploadQueue;
  unsubscribeSteering: (() => void) | null;
  resetMessageLog(): void;
  disposeStack(): Promise<void>;
  printRestored(): void;
  startStack(port: number, host: string | null): Promise<void>;
};

function internalsOf(hub: ServeHub): HubInternals {
  return hub as unknown as HubInternals;
}

function upload(filename: string, data = 'QUJD'): FileUploadEntry {
  return { filename, data, mimeType: 'text/plain' };
}

describe('FileUploadQueue is flushed on teardown (defect A)', () => {
  let hub: ServeHub;

  beforeEach(() => {
    hub = new ServeHub();
  });

  afterEach(() => {
    setWebUiUp(false);
    vi.restoreAllMocks();
  });

  it('stop() empties the buffer so a late upload cannot leak into the NEXT session', async () => {
    // A file attached while the session is live ...
    hub.pushFileUpload(upload('late.txt'));
    expect(hub.getFileUploads().map((f) => f.filename), 'buffer holds the upload before stop').toEqual([
      'late.txt'
    ]);

    await hub.stop(true);

    // ... must be GONE once the stack is down. Before the fix it was still
    // buffered (nothing called reset()), and the next session's first turn
    // drained it — a file the user never attached to that turn.
    expect(hub.getFileUploads()).toEqual([]);
  });

  it('stop() calls FileUploadQueue.reset() (the teardown call HEAD had)', async () => {
    const internals = internalsOf(hub);
    const resetSpy = vi.spyOn(internals.fileUploadQueue, 'reset');

    hub.pushFileUpload(upload('late.txt'));
    await hub.stop(true);

    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(internals.fileUploadQueue.size).toBe(0);
  });

  it('a restartServe() recycle ALSO leaves the buffer empty (stop(true) is shared)', async () => {
    // The recycle path runs the same stop(true), so an upload attached just
    // before 重启 must not survive into the restarted stack either.
    const internals = internalsOf(hub);
    vi.spyOn(internals, 'startStack').mockImplementation(async () => {
      /* no port bound; the transition is what we assert */
    });

    hub.pushFileUpload(upload('before-restart.txt'));
    expect(internals.fileUploadQueue.size).toBe(1);

    await hub.restartServe();

    expect(internals.fileUploadQueue.size).toBe(0);
  });
});

describe('upload frames reach the SAME messageLog the readers measure (defect B)', () => {
  let hub: ServeHub;

  beforeEach(() => {
    hub = new ServeHub();
  });

  afterEach(() => {
    setWebUiUp(false);
    vi.restoreAllMocks();
  });

  it('file-upload and file-flush rows land in messageLog and in dumpSnapshot counts', () => {
    const internals = internalsOf(hub);
    const log = internals.messageLog;

    // Baseline: the dump's readers agree the log is empty.
    const before = hub.dumpSnapshot(0).diagnostics;
    expect(before.messageLogLength).toBe(0);
    expect(before.historyRows, 'no transcript → historyRows IS messageLog.length').toBe(0);

    hub.pushFileUpload(upload('a.txt'));

    // THE IDENTITY: the row went into the very array the hub's field holds —
    // the one /history's fallback serves and dumpSnapshot measures. A
    // broadcast into a second, private log would leave this one empty.
    expect(internals.messageLog, 'the log object was not swapped').toBe(log);
    expect(log.map((e) => e.type)).toEqual(['file-upload']);
    expect(log[0].content).toBe('a.txt');

    const afterUpload = hub.dumpSnapshot(0).diagnostics;
    expect(afterUpload.messageLogLength, 'dumpSnapshot sees the upload row').toBe(1);
    expect(afterUpload.historyRows, '/history fallback sees the upload row').toBe(1);

    const drained = hub.drainFileUploads();
    expect(drained.map((f) => f.filename)).toEqual(['a.txt']);

    expect(log.map((e) => e.type), 'file-flush appended to the same log').toEqual(['file-upload', 'file-flush']);
    const afterFlush = hub.dumpSnapshot(0).diagnostics;
    expect(afterFlush.messageLogLength).toBe(2);
    expect(afterFlush.historyRows).toBe(2);
  });

  it('the oversized-upload rejection is logged (it used to vanish on reload)', () => {
    const internals = internalsOf(hub);
    const log = internals.messageLog;

    // 400 base64 chars ≈ 300 bytes > the 0.0001 MB cap mocked above.
    hub.pushFileUpload(upload('huge.bin', 'A'.repeat(400)));

    // Rejected: NOT buffered ...
    expect(hub.getFileUploads()).toEqual([]);
    // ... but the notice IS a log row, carrying HEAD's 'serve' label, so the
    // no-transcript /history fallback replays it after a reload.
    expect(log.map((e) => e.type)).toEqual(['error']);
    expect(log[0].label).toBe('serve');
    expect(log[0].content).toContain('上传被拒绝');
    expect(log[0].content).toContain('huge.bin');
    expect(hub.dumpSnapshot(0).diagnostics.messageLogLength).toBe(1);
  });

  it('follows the hub when it REASSIGNS messageLog — a captured array would go stale', () => {
    const internals = internalsOf(hub);
    const first = internals.messageLog;

    hub.pushFileUpload(upload('first.txt'));
    expect(first.map((e) => e.type)).toEqual(['file-upload']);

    // The hub reassigns the field on every start / stop / `/clear` boundary.
    // Simulate that here (this is exactly what resetMessageLog does).
    internals.resetMessageLog();
    const second = internals.messageLog;
    expect(second, 'the hub now holds a NEW array').not.toBe(first);
    expect(second).toEqual([]);

    hub.pushFileUpload(upload('second.txt'));

    // THE FALSIFIABLE ASSERTION: the row must land in the CURRENT array. A
    // queue that captured the array instead of the thunk would push into
    // `first` and leave `second` empty — the row lost to a log nobody reads.
    expect(second.map((e) => e.type)).toEqual(['file-upload']);
    expect(second[0].content).toBe('second.txt');
    expect(first, 'the abandoned array did not grow').toEqual([
      expect.objectContaining({ type: 'file-upload', content: 'first.txt' })
    ]);
    expect(hub.dumpSnapshot(0).diagnostics.messageLogLength).toBe(1);
  });

  it('draining an EMPTY buffer emits no file-flush row (no log pollution)', () => {
    const internals = internalsOf(hub);
    expect(hub.drainFileUploads()).toEqual([]);
    expect(internals.messageLog).toEqual([]);
  });
});

describe('gracefulShutdown() runs its tail through a teardown failure (fold-in 1)', () => {
  let hub: ServeHub;

  beforeEach(() => {
    hub = new ServeHub();
  });

  afterEach(() => {
    setWebUiUp(false);
    vi.restoreAllMocks();
  });

  it('a throwing dispose still prints the restore message and settles the input wait', async () => {
    const internals = internalsOf(hub);
    vi.spyOn(internals, 'disposeStack').mockRejectedValue(new Error('dispose boom'));

    // Record the ORDER: the restore message must print BEFORE the terminal
    // prompt is unblocked (the "ESC quit serve" race this ordering protects).
    const order: string[] = [];
    vi.spyOn(internals, 'printRestored').mockImplementation(() => {
      order.push('printRestored');
    });

    const pending = hub.waitForInput();
    pending.then(() => order.push('abortInput'));

    // stop()'s rejection propagates (it is the caller's signal that the
    // teardown failed) — but must not swallow the tail.
    await expect(hub.gracefulShutdown()).rejects.toThrow('dispose boom');

    const settled = await Promise.race([
      pending.then((v) => ({ status: 'settled' as const, value: v })),
      new Promise<{ status: 'pending' }>((resolve) => setTimeout(() => resolve({ status: 'pending' }), 50))
    ]);
    expect(settled.status, 'the terminal wait was unblocked despite the throw').toBe('settled');
    expect((settled as { value: { text: string | null } }).value.text).toBeNull();

    expect(internals.printRestored, 'mirroring was unwired despite the throw').toHaveBeenCalledTimes(1);
    expect(order, 'print-then-abort order preserved').toEqual(['printRestored', 'abortInput']);
  });

  it('abortInput() still runs when printRestored() itself throws', async () => {
    const internals = internalsOf(hub);
    vi.spyOn(internals, 'printRestored').mockImplementation(() => {
      throw new Error('print boom');
    });

    const pending = hub.waitForInput();

    await expect(hub.gracefulShutdown()).rejects.toThrow('print boom');

    const settled = await Promise.race([
      pending.then(() => 'settled' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 50))
    ]);
    expect(settled, 'a broken restore message must not hang the terminal').toBe('settled');
  });
});

describe("start()'s failure path tears down the steering observer it armed (fold-in 2)", () => {
  let hub: ServeHub;

  beforeEach(() => {
    hub = new ServeHub();
  });

  afterEach(() => {
    setWebUiUp(false);
    vi.restoreAllMocks();
  });

  /** Listener count of the process-wide manager (the observer registry). */
  function steeringListenerCount(): number {
    return (getSteeringManager() as unknown as { listeners: Set<unknown> }).listeners.size;
  }

  it('a failed start leaves NO observer behind', async () => {
    const internals = internalsOf(hub);
    vi.spyOn(internals, 'startStack').mockRejectedValue(new Error('EADDRINUSE'));

    const baseline = steeringListenerCount();

    await expect(hub.start(1234, '127.0.0.1')).rejects.toThrow('EADDRINUSE');

    // start() arms an observer BEFORE mounting the stack (so a note queued
    // during startup is reported). Without the catch-side teardown it leaked,
    // and the next successful start() would subscribe a SECOND one — two
    // emissions per mutation.
    expect(steeringListenerCount(), 'the observer was unsubscribed').toBe(baseline);
    expect(internals.unsubscribeSteering, 'the hub handle was cleared').toBeNull();
    expect(hub.isRunning()).toBe(false);
  });

  it('a retry after the failure subscribes exactly ONE observer', async () => {
    const internals = internalsOf(hub);
    const startStack = vi.spyOn(internals, 'startStack');
    startStack.mockRejectedValueOnce(new Error('EADDRINUSE'));

    const baseline = steeringListenerCount();

    await expect(hub.start(1234, '127.0.0.1')).rejects.toThrow('EADDRINUSE');

    // Retry succeeds (no port is actually bound by the stub).
    startStack.mockResolvedValueOnce(undefined);
    await hub.start(1234, '127.0.0.1');
    expect(hub.isRunning()).toBe(true);
    expect(steeringListenerCount(), 'exactly one observer, not two').toBe(baseline + 1);

    await hub.stop(true);
    expect(steeringListenerCount(), 'stop() tears its own observer down').toBe(baseline);
  });
});

describe('source wiring keeps the upload queue log-aware (drift guard)', () => {
  it('the hub builds FileUploadQueue with a thunk over its own messageLog', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const hubSrc = fs.readFileSync(path.resolve(__dirname, '..', '..', 'serve', 'serve-hub.ts'), 'utf-8');

    // A future edit that passes the ARRAY (`this.messageLog`) instead of the
    // thunk re-introduces the stale-log defect silently — the behaviour tests
    // above would still pass for a hub that never reassigned the field in the
    // window they observe. This pins the CONTRACT at the construction site.
    expect(hubSrc).toContain('new FileUploadQueue(this.clients, () => this.messageLog)');
    expect(/new FileUploadQueue\(\s*this\.clients\s*,\s*this\.messageLog\s*\)/.test(hubSrc)).toBe(false);

    // And the queue must forward that log on every frame it emits.
    const queueSrc = fs.readFileSync(path.resolve(__dirname, '..', '..', 'serve', 'serve-queues.ts'), 'utf-8');
    const broadcasts = queueSrc.match(/this\.clients\.broadcast\(/g) ?? [];
    expect(broadcasts.length, 'three frames: rejection, file-upload, file-flush').toBe(3);
    expect(queueSrc.match(/this\.messageLog\(\)/g)?.length, 'each frame supplies the log').toBe(3);
  });
});
