/**
 * abort-cause.test.ts
 *
 * Regression test for the "bare AbortError" report:
 *
 *   [collect] messages(raw)=445 tokens=226758
 *   AbortError: This operation was aborted
 *     at OllamaChatStream.connect (src/engine/ollama-http.ts:329)
 *   COLLECT state error: This operation was aborted
 *
 * THREE separate defects produced that screen:
 *
 * 1. `OllamaChatStream.connect` let the AbortController's own DOMException
 *    escape. Every event that aborts the chat POST — ESC, the per-attempt POST
 *    deadline, a non-2xx response — reached the user as the SAME generic
 *    message, naming neither the trigger nor the endpoint.
 * 2. `retryChat` aborted the controller with NO reason, so even the
 *    information mycc itself held (the deadline) was discarded.
 * 3. `isTransientError()` matched the substring 'aborted'. A cancelled fetch
 *    therefore looked like a network hiccup: retryChat re-sent the whole
 *    request 4× with backoff, and COLLECT's transient branch offered a turn
 *    retry — with a 226k-token conversation, exactly the cost ESC is meant to
 *    avoid.
 *
 * This suite pins the corrected contract:
 *  - a cancellation is recognised structurally and is NEVER transient;
 *  - a POST rejected by an abort surfaces a descriptive (retryable) timeout
 *    when the transport itself aborted it, and cancellation when the caller's
 *    signal did;
 *  - the descriptive error is retryable (StreamTimeoutError path), while a
 *    genuine transport rejection (`TypeError: terminated`) keeps its existing
 *    normalization.
 */

import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import { OllamaHttpClient, classifyConnectFailure } from '../../engine/ollama-http.js';
import {
  isTransientError,
  normalizeFetchError,
  StreamTimeoutError,
  StreamAbortedError,
  isCancellationError,
  cancelledByCaller
} from '../../engine/chat-helpers.js';
import { isCancellation } from '../../loop/cancellation.js';

const abortDomException = () => new DOMException('This operation was aborted', 'AbortError');

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(rejection: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(rejection))
  );
}

/** Real classes, injected exactly as ollama.ts wires them in production. */
const errors = {
  cancelled: (cause?: unknown) => new StreamAbortedError(cause),
  timedOut: (message: string, reason: 'first-token' | 'liveness', cause?: unknown) =>
    new StreamTimeoutError(message, reason, cause)
};

const chatRequest = {
  model: 'test-model',
  messages: [{ role: 'user', content: 'hi' }]
};

describe('isTransientError() and cancellation', () => {
  it('treats an abort DOMException as cancellation, never as transient', () => {
    const err = abortDomException();
    expect(isCancellation(err)).toBe(true);
    // Structural, not by message: the removal of the 'aborted' pattern means
    // the message alone must NOT make anything transient. Pinned here so a
    // future re-add of that substring fails this test.
    expect(err.message.toLowerCase()).toContain('aborted');
    expect(isTransientError(err)).toBe(false);
    expect(isTransientError(new Error('the operation was aborted'))).toBe(false);
  });

  it('treats our own StreamAbortedError as cancellation, never as transient', () => {
    expect(isTransientError(new StreamAbortedError())).toBe(false);
  });

  it('still treats real transport failures as transient', () => {
    expect(isTransientError(new Error('socket hang up'))).toBe(true);
    expect(isTransientError(new Error('ECONNRESET'))).toBe(true);
    // A bare `TypeError: terminated` is NOT transient by itself — it is the
    // case normalizeFetchError() exists for; retryChat normalizes first.
    expect(isTransientError(new TypeError('terminated'))).toBe(false);
    expect(isTransientError(normalizeFetchError(new TypeError('terminated')))).toBe(true);
  });

  it('still treats a genuine socket ABORT as transient (not a cancellation)', () => {
    // The 'aborted' substring was removed from the pattern list because
    // cancellation is decided structurally first — but the socket-level CODES
    // contain the same word and are real transport faults. Dropping them too
    // would make a reset connection look fatal.
    expect(isTransientError(new Error('connect ECONNABORTED 127.0.0.1:11434'))).toBe(true);
    expect(isTransientError(new Error('read ECONNABORTED'))).toBe(true);
    // The Windows PROSE wording carries no code, so it needs its own entry —
    // pinned so that a future cleanup of the list cannot silently drop it.
    expect(
      isTransientError(new Error('An established connection was aborted by the software in your host machine.'))
    ).toBe(true);
    expect(
      isTransientError(
        new Error(
          'A connection attempt failed because the connected party did not properly respond after a period of time'
        )
      )
    ).toBe(true);
    // ...while an intentional cancellation of the same word stays non-transient.
    expect(isTransientError(new Error('This operation was aborted'))).toBe(false);
  });

  it('still treats a timeout as transient (it is retried with escalation)', () => {
    expect(isTransientError(new StreamTimeoutError('POST timed out after 20000ms', 'first-token'))).toBe(true);
  });
});

describe('classifyConnectFailure precedence', () => {
  const deadline = () => new StreamTimeoutError('Ollama POST timed out after 20000ms (connection hang)', 'first-token');

  it('reports cancellation when the caller aborted, even with a deadline reason recorded', () => {
    const verdict = classifyConnectFailure(abortDomException(), true, deadline());
    expect(verdict.kind).toBe('cancelled');
  });

  it('returns the recorded reason when the rejection IS that reason (the POST deadline)', () => {
    // THE round-3 fix. `retryChat`'s deadline aborts the very controller
    // `connect()` sees as its caller signal, so callerAborted is TRUE for a
    // connection hang; only the identity rule stops that being reported as a
    // user cancellation (which would kill retry and escalation). Uses ONE
    // shared instance — passing two different objects would let the rule be
    // deleted with this test still green.
    const d = deadline();
    expect(classifyConnectFailure(d, true, d)).toEqual({ kind: 'reason', reason: d });
  });

  it('reports cancellation for the caller marker recorded by retryChat', () => {
    const verdict = classifyConnectFailure(cancelledByCaller(), false, cancelledByCaller());
    expect(verdict.kind).toBe('cancelled');
  });

  it('reports cancellation for a SHARED marker instance, never as a descriptive reason', () => {
    // The marker is an Error, so a shared instance satisfies `error === reason`
    // too. Cancellation must win over the identity rule.
    const marker = cancelledByCaller();
    expect(classifyConnectFailure(marker, false, marker).kind).toBe('cancelled');
    expect(classifyConnectFailure(marker, true, marker).kind).toBe('cancelled');
  });

  it('prefers a descriptive Error reason recorded on our own controller (the POST deadline)', () => {
    const error = deadline();
    const verdict = classifyConnectFailure(abortDomException(), false, error);
    expect(verdict).toEqual({ kind: 'reason', reason: error });
  });

  it('reports a timeout when our controller aborted with no reason', () => {
    expect(classifyConnectFailure(abortDomException(), false, undefined).kind).toBe('timeout');
  });

  it('passes a genuine transport failure through untouched', () => {
    const terminated = new TypeError('terminated');
    expect(classifyConnectFailure(terminated, false, undefined).kind).toBe('passthrough');
    expect(classifyConnectFailure(terminated, false, deadline()).kind).toBe('passthrough');
  });

  it('never mistakes the caller-cancel marker for a descriptive reason', () => {
    // The marker is an Error subclass, so an ERROR-first check would return it
    // as the "descriptive reason" and lose the cancellation classification.
    expect(classifyConnectFailure(abortDomException(), false, cancelledByCaller()).kind).toBe('cancelled');
    expect(isCancellationError(cancelledByCaller())).toBe(true);
    expect(isCancellation(cancelledByCaller())).toBe(true);
    expect(isTransientError(cancelledByCaller())).toBe(false);
  });
});

describe('OllamaChatStream.connect abort explanation', () => {
  it('names the POST abort (not a bare AbortError) when nobody external cancelled', async () => {
    stubFetch(abortDomException());
    const client = new OllamaHttpClient({ host: 'http://127.0.0.1:11434', errors });

    const error = await client
      .chat({ ...chatRequest, stream: true })
      .then(() => null)
      .catch((e: unknown) => e as Error);

    expect(error).toBeInstanceOf(StreamTimeoutError);
    expect(error?.message).not.toBe('This operation was aborted');
    expect(error?.message).toContain('aborted before response headers');
    // Retryable: the caller can retry rather than showing an opaque abort.
    expect(isTransientError(error)).toBe(true);
  });

  it('reports cancellation when the CALLER aborted the request', async () => {
    const controller = new AbortController();
    stubFetch(abortDomException());
    const client = new OllamaHttpClient({ host: 'http://127.0.0.1:11434', errors });

    controller.abort();
    const error = await client
      .chat({ ...chatRequest, stream: true }, controller.signal)
      .then(() => null)
      .catch((e: unknown) => e as Error);

    expect(error).toBeInstanceOf(StreamAbortedError);
    expect(isTransientError(error)).toBe(false);
  });

  it('leaves a genuine transport rejection untouched for the retry normalizer', async () => {
    stubFetch(new TypeError('terminated'));
    const client = new OllamaHttpClient({ host: 'http://127.0.0.1:11434', errors });

    const error = await client
      .chat({ ...chatRequest, stream: true })
      .then(() => null)
      .catch((e: unknown) => e as Error);

    expect(error).toBeInstanceOf(TypeError);
    expect(error?.message).toBe('terminated');
  });

  it('reports the caller cancellation, not the POST deadline, when both are aborted', async () => {
    // ESC lands while the deadline timer is already in flight. The caller owns
    // the outcome: reporting a timeout here would tell the user their network
    // hung when they simply pressed ESC.
    const deadline = new StreamTimeoutError('Ollama POST timed out after 20000ms (connection hang)', 'first-token');
    const client = new OllamaHttpClient({ host: 'http://127.0.0.1:11434', errors });

    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(abortDomException()));
          })
      )
    );

    const controller = new AbortController();
    const pending = client.chat({ ...chatRequest, stream: true }, controller.signal);
    controller.abort();

    const error = await pending.then(() => null).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(StreamAbortedError);
    expect(error).not.toBe(deadline);
    expect(isTransientError(error)).toBe(false);
  });
});

describe('ConnectFailureErrors default factory', () => {
  // A client constructed WITHOUT injected error classes (rag-*.ts, health
  // check) must still produce errors the structural checks recognise: the
  // default builds plain Errors whose `name` matches the real classes.
  it('produces structurally recognisable errors when nothing is injected', async () => {
    stubFetch(abortDomException());
    const client = new OllamaHttpClient({ host: 'http://127.0.0.1:11434' });

    const error = await client
      .chat({ ...chatRequest, stream: true })
      .then(() => null)
      .catch((e: unknown) => e as Error);

    expect(error?.name).toBe('StreamTimeoutError');
    expect(isTransientError(error)).toBe(true);
    // The `reason` field is what retryChat reads to decide whether to escalate
    // the first-token deadline (20→40→80s). A default-factory error that lost
    // it silently disabled escalation for every non-injected client.
    expect((error as { reason?: unknown })?.reason).toBe('first-token');
    // Not the real class — but nothing on this path may depend on `instanceof`
    // (chat/vision always inject; embed-only callers never reach this branch).
    expect(error).not.toBeInstanceOf(StreamTimeoutError);
  });

  it('marks a caller cancellation structurally as StreamAbortedError', async () => {
    const controller = new AbortController();
    stubFetch(abortDomException());
    const client = new OllamaHttpClient({ host: 'http://127.0.0.1:11434' });

    controller.abort();
    const error = await client
      .chat({ ...chatRequest, stream: true }, controller.signal)
      .then(() => null)
      .catch((e: unknown) => e as Error);

    expect(error?.name).toBe('StreamAbortedError');
    expect(isCancellation(error)).toBe(true);
    expect(isTransientError(error)).toBe(false);
  });
});
