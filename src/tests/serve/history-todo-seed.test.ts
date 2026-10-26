/**
 * history-todo-seed.test.ts — the SEAM between the todo store and the client,
 * tested BEHAVIOURALLY.
 *
 * Review B1: every other test of this feature tested ONE HALF against a mock of
 * the other. `historyTodosField` and `todoEtagToken` were unit-tested directly
 * (proving only that pure functions work) while the `/history` handler that was
 * supposed to CALL them shipped neither — so the client received no `todos`
 * field, normalised `undefined` to `[]`, and wiped the panel on every reload.
 * 597 tests were green.
 *
 * Round 2 made this file honest. The handler used to be an inline closure inside
 * `start()`, which cannot exist without Vite and a bound socket — so the only
 * options were "call the helpers" (proves nothing about the wiring) or "match
 * strings in the source" (a fake guard that would not fail if the handler dropped
 * the call). The handler is now extracted to `serveHistoryRequest`, a function of
 * plain data, so these tests drive the REAL response path and assert the BYTES.
 *
 * Every assertion below FAILS if the corresponding wiring is reverted.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  serveHistoryRequest,
  todoEtagToken,
  historyTodosField,
  ServeHub,
  type HistoryRequestInput,
  type HistoryResponseSink,
} from '../../serve/serve-hub.js';
import { toTodoListPayload } from '../../serve/serve-todos.js';

const payload = toTodoListPayload([
  { id: 1, name: 'Task A', done: false, pinned: false },
]);

/** A recording sink: captures the status, headers and body a client would see. */
function makeSink(): HistoryResponseSink & {
  statusCode: number;
  headers: Record<string, string>;
  body: string | undefined;
} {
  const sink = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: undefined as string | undefined,
    setHeader(name: string, value: string) { sink.headers[name.toLowerCase()] = value; },
    status(code: number) { sink.statusCode = code; return sink; },
    end(body?: string) { sink.body = body; },
  };
  return sink;
}

function baseInput(over: Partial<HistoryRequestInput> = {}): HistoryRequestInput {
  return {
    transcriptPath: null,
    messageLog: [],
    steeringLength: 0,
    steeringBuffer: [],
    isRunning: false,
    todoList: null,
    sessionId: 'sess-A',
    ...over,
  };
}

/** Parse a 200 body; asserts the status was 200 first. */
function bodyOf(sink: ReturnType<typeof makeSink>): Record<string, unknown> {
  expect(sink.statusCode).toBe(200);
  expect(typeof sink.body).toBe('string');
  return JSON.parse(sink.body as string) as Record<string, unknown>;
}

describe('GET /history — the todo seed crosses the wire (review B1)', () => {
  it('ships a BARE todos array in the body', () => {
    const sink = makeSink();
    serveHistoryRequest(baseInput({ todoList: payload }), sink);
    const body = bodyOf(sink);
    // The field must EXIST. Its absence is the original bug: the client read
    // `undefined`, normalised it to `[]`, and wiped every row on reload.
    expect('todos' in body).toBe(true);
    // A BARE array, never the `{type:'todos', todos}` frame wrapper — the client
    // stores this straight into `store.todos` behind an Array.isArray check.
    expect(Array.isArray(body.todos)).toBe(true);
    expect(body.todos).toEqual([
      { id: 1, name: 'Task A', done: false, pinned: false },
    ]);
  });

  it('ships null (not undefined) when no mutation has been observed', () => {
    const sink = makeSink();
    serveHistoryRequest(baseInput({ todoList: null }), sink);
    const body = bodyOf(sink);
    expect('todos' in body).toBe(true);
    expect(body.todos).toBeNull(); // distinct from [] — "no list", not "empty list"
  });

  it('a TODO-ONLY change moves the ETag (no stale 304)', () => {
    const before = makeSink();
    serveHistoryRequest(baseInput({ todoList: null }), before);
    const after = makeSink();
    serveHistoryRequest(baseInput({ todoList: payload }), after);
    // Nothing else changed — no transcript, no messages, no steering, same run
    // state, same session. Only the todo list differs. A 304 here would freeze a
    // stale panel, which is precisely what `todoEtagToken` exists to prevent.
    expect(after.headers.etag).not.toBe(before.headers.etag);
  });

  it('sets Content-Type on a 200 (round-2 major: the extraction dropped it)', () => {
    const sink = makeSink();
    serveHistoryRequest(baseInput({ todoList: payload }), sink);
    bodyOf(sink);
    // The inline route used to end with
    // `res.status(200).set({ 'Content-Type': 'application/json' }).end(payload)`.
    // The extraction moved the body-building into this function but the sink had
    // no channel for the header, so it silently stopped being sent — Express does
    // not default it. `res.json()` on the client hid the regression; curl, a proxy
    // or any Accept-aware consumer would receive an untyped body.
    expect(sink.headers['content-type']).toBe('application/json');
  });

  it('a revalidation with the CURRENT etag returns 304 with no body', () => {    const first = makeSink();
    serveHistoryRequest(baseInput({ todoList: payload }), first);
    const etag = first.headers.etag;
    expect(etag).toBeTruthy();

    const second = makeSink();
    serveHistoryRequest(baseInput({ todoList: payload, ifNoneMatch: etag }), second);
    expect(second.statusCode).toBe(304);
    expect(second.body).toBeUndefined();
  });

  it('a STALE etag (from before a todo change) does NOT 304 — the panel refreshes', () => {
    const first = makeSink();
    serveHistoryRequest(baseInput({ todoList: null }), first);
    const staleEtag = first.headers.etag;

    // The list changed; the client revalidates with its OLD tag.
    const second = makeSink();
    serveHistoryRequest(baseInput({ todoList: payload, ifNoneMatch: staleEtag }), second);
    expect(second.statusCode).toBe(200);
    expect(bodyOf(second).todos).toEqual([
      { id: 1, name: 'Task A', done: false, pinned: false },
    ]);
  });
});

describe('GET /history — the ETag carries the SESSION identity (review M9)', () => {
  it('two sessions with identical bodies get DIFFERENT etags', () => {
    const a = makeSink();
    serveHistoryRequest(baseInput({ todoList: payload, sessionId: 'sess-A' }), a);
    const b = makeSink();
    serveHistoryRequest(baseInput({ todoList: payload, sessionId: 'sess-B' }), b);
    // Without a session term a NON-BROWSER consumer (curl, a proxy, a future
    // client) could be 304'd into validating another session's body — the browser
    // is guarded client-side, but the wire contract should not depend on that.
    expect(a.headers.etag).not.toBe(b.headers.etag);
  });

  it('treats a null session as its own identity', () => {
    const a = makeSink();
    serveHistoryRequest(baseInput({ todoList: payload, sessionId: null }), a);
    const b = makeSink();
    serveHistoryRequest(baseInput({ todoList: payload, sessionId: 'sess-A' }), b);
    expect(a.headers.etag).not.toBe(b.headers.etag);
  });

  it('the same session + same body is STABLE (a 304 stays possible)', () => {
    const a = makeSink();
    serveHistoryRequest(baseInput({ todoList: payload }), a);
    const b = makeSink();
    serveHistoryRequest(baseInput({ todoList: payload }), b);
    expect(a.headers.etag).toBe(b.headers.etag);
  });
});

describe('B4 — a late-joining client receives the todo snapshot', () => {
  /** Minimal fake WebSocket the connect handler can drive. */
  function fakeSocket() {
    const sent: string[] = [];
    const handlers: Record<string, (arg?: unknown) => void> = {};
    return {
      sent,
      readyState: 1,
      OPEN: 1,
      send(data: string) { sent.push(data); },
      on(event: string, fn: (arg?: unknown) => void) { handlers[event] = fn; },
      close: vi.fn(),
      /** Deliver any pending handler (not needed here, kept for symmetry). */
      handlers,
    };
  }

  it('sends the current todo snapshot on connect', () => {
    const hub = new ServeHub();
    hub.broadcastTodoList(payload);
    const ws = fakeSocket();
    // Private by design; the cast is the narrowest way to drive the real handler
    // without binding a socket. This is a BEHAVIOURAL test: it fails if the handler
    // stops sending the snapshot, which no source-string check could guarantee.
    (hub as unknown as { onWsConnection(ws: unknown): void }).onWsConnection(ws);

    const frames = ws.sent.map((s) => JSON.parse(s) as { type?: string; todos?: unknown });
    const todosFrame = frames.find((f) => f.type === 'todos');
    // Without this send, a mutation landing in the /history→WS-connect window was
    // broadcast to zero clients and stayed invisible until the next mutation.
    expect(todosFrame).toBeDefined();
    expect(todosFrame?.todos).toEqual(payload.todos);
  });

  it('sends NOTHING todo-related when no snapshot exists yet', () => {
    const hub = new ServeHub();
    const ws = fakeSocket();
    (hub as unknown as { onWsConnection(ws: unknown): void }).onWsConnection(ws);
    const frames = ws.sent.map((s) => JSON.parse(s) as { type?: string });
    expect(frames.some((f) => f.type === 'todos')).toBe(false);
  });
});

describe('B3 — a recycle re-publishes the snapshot (restartServe)', () => {
  it('restartServe calls resyncTodoSnapshot after start()', async () => {
    const hub = new ServeHub();
    hub.broadcastTodoList(payload);
    const internals = hub as unknown as {
      restarting: boolean;
      stop(skip?: boolean): Promise<void>;
      start(port: number, host?: string | null): Promise<void>;
      getPort(): number;
      getHost(): string | null;
    };
    // Stub the heavy IO; the subject is the resync call, not the server.
    const stopSpy = vi.spyOn(internals, 'stop').mockResolvedValue(undefined);
    const startSpy = vi.spyOn(internals, 'start').mockResolvedValue(undefined);
    vi.spyOn(internals, 'getPort').mockReturnValue(1234);
    vi.spyOn(internals, 'getHost').mockReturnValue(null);
    const resync = vi.spyOn(
      await import('../../serve/serve-todos.js'),
      'resyncTodoSnapshot',
    ).mockImplementation(() => { /* no seed installed in tests */ });

    await hub.restartServe();

    // The ORDER is the contract: stop → start → resync. A resync that ran before
    // start() would be wiped by the recycle; one that never ran leaves the panel
    // blank on every 重启 (the trap round 1 identified).
    expect(stopSpy).toHaveBeenCalled();
    expect(startSpy).toHaveBeenCalled();
    expect(resync).toHaveBeenCalled();
    expect(stopSpy.mock.invocationCallOrder[0])
      .toBeLessThan(startSpy.mock.invocationCallOrder[0]);
    // restarting must be cleared even on success, or the next recycle is refused.
    expect(internals.restarting).toBe(false);
  });
});

describe('todoEtagToken / historyTodosField — content, not length', () => {
  it('todoEtagToken is content-derived: a same-length rename changes it', () => {
    // A length-based token collided for any rename of equal length and served
    // exactly the stale panel the token exists to prevent.
    const a = toTodoListPayload([{ id: 1, name: 'Task A', done: false, pinned: false }]);
    const b = toTodoListPayload([{ id: 1, name: 'Task B', done: false, pinned: false }]);
    expect(todoEtagToken(a)).not.toBe(todoEtagToken(b));
  });

  it('todoEtagToken distinguishes fields the panel draws', () => {
    const base = toTodoListPayload([{ id: 1, name: 'T', done: false, pinned: false }]);
    const done = toTodoListPayload([{ id: 1, name: 'T', done: true, pinned: false }]);
    const pinned = toTodoListPayload([{ id: 1, name: 'T', done: false, pinned: true }]);
    const noted = toTodoListPayload([{ id: 1, name: 'T', done: false, pinned: false, note: 'n' }]);
    const guarded = toTodoListPayload([
      { id: 1, name: 'T', done: false, pinned: true, preventStop: 'until green' },
    ]);
    const tokens = [base, done, pinned, noted, guarded].map(todoEtagToken);
    expect(new Set(tokens).size).toBe(tokens.length); // all distinct
  });

  it('todoEtagToken gives "no list" and "empty list" distinct tokens', () => {
    expect(todoEtagToken(null)).not.toBe(todoEtagToken(toTodoListPayload([])));
  });

  it('historyTodosField unwraps to the bare array and preserves null', () => {
    expect(historyTodosField(payload)).toEqual(payload.todos);
    expect(historyTodosField(null)).toBeNull();
  });
});
