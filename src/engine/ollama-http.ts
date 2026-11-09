/**
 * ollama-http.ts - mycc-owned HTTP transport for Ollama's REST API.
 *
 * Replaces the runtime ollama-js client used by chat/vision, embeddings, model
 * metadata, health checks and the web tools. Chat uses NDJSON streaming with
 * an explicit AbortController so the existing stream watchdog retains
 * cancellation.
 *
 * This module owns the ONE set of primitives every Ollama request shares:
 *   - host normalization (`normalizeHost`)
 *   - the error type and its classification (`OllamaHttpError` / `httpError`)
 *   - Retry-After parsing in BOTH wire forms (`parseRetryAfter`)
 *   - the POST helper used by both the chat client and the web client
 *   - image encoding (`encodeImages`)
 *
 * ollama-web.ts deliberately builds on these instead of keeping a parallel
 * implementation: two copies of error/retry semantics drift, and the web path
 * once disagreed with the chat path about both the Retry-After format and how
 * to classify an auth failure.
 */

import type {
  ChatRequest,
  ChatResponse,
  EmbedRequest,
  EmbedResponse,
  ModelInfo,
  ModelListResponse,
  ProviderMessage
} from './provider-types.js';

/**
 * How a failed Ollama HTTP request should be understood by the caller.
 *
 * `base-core.ts` used to detect auth failures by searching the error MESSAGE
 * for "401"/"unauthorized" — fragile, and blind to an error delivered as a
 * 200 response body. Classification belongs here, next to the status code.
 */
export type OllamaErrorKind = 'auth' | 'rate-limit' | 'server' | 'client' | 'transport';

function classify(status: number): OllamaErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limit';
  if (status >= 500) return 'server';
  if (status >= 400) return 'client';
  return 'transport';
}

export class OllamaHttpError extends Error {
  readonly kind: OllamaErrorKind;

  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
    readonly signinUrl?: string
  ) {
    const auth = status === 401 ? ' Unauthorized' : status === 403 ? ' Forbidden' : '';
    super(`HTTP ${status}${auth}: ${message}`);
    this.name = 'OllamaHttpError';
    this.kind = classify(status);
  }
}

/**
 * Preserve the legacy ollama-js host forms and reverse-proxy path prefix, and
 * reject host shapes we will not talk to.
 *
 * Validation beyond what `new URL()` enforces:
 * - Only http/https. `file:`, `ws:`, `data:` … would otherwise be handed to
 *   `fetch()` and fail far from the configuration that caused it.
 * - No credentials in the URL (`https://user:pass@host`). The Ollama client
 *   authenticates with a bearer header; a userinfo component silently changes
 *   how the proxy sees the request and is a common way to smuggle a different
 *   authority, so treat it as a configuration error rather than "parse it".
 * - Trailing dot in the hostname is stripped: `ollama.com.` is the same DNS
 *   name as `ollama.com` but compares unequal, which would defeat the
 *   direct-cloud check.
 */
export function normalizeHost(host: string): string {
  const value = host.trim();
  const withProtocol = value.startsWith(':')
    ? `http://127.0.0.1${value}`
    : value.includes('://')
      ? value
      : `http://${value}`;
  const url = new URL(withProtocol);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported OLLAMA_HOST protocol "${url.protocol}": only http:// and https:// are supported`);
  }
  if (url.username || url.password) {
    throw new Error('OLLAMA_HOST must not embed credentials; set OLLAMA_API_KEY instead');
  }
  if (url.hostname.endsWith('.')) url.hostname = url.hostname.slice(0, -1);
  if (!url.port) {
    url.port = value.includes('://') ? (url.protocol === 'https:' ? '443' : '80') : '11434';
  }
  return url.toString().replace(/\/$/, '');
}

/**
 * Parse a Retry-After header in BOTH wire forms: delta-seconds (`120`) and
 * HTTP-date (`Wed, 21 Oct 2026 07:28:00 GMT`). Sharing this between the chat
 * and web paths keeps their backoff behaviour identical.
 */
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/**
 * Encode every image on a message list for the Ollama wire format.
 *
 * Ollama accepts base64 strings; callers may hand us raw bytes (screen,
 * read_picture). Both the streaming and non-streaming chat paths go through
 * THIS function — they used to carry separate inline copies, so a change to
 * one silently diverged from the other.
 */
export function encodeImages(messages: ProviderMessage[] | undefined): ProviderMessage[] | undefined {
  return messages?.map((message) =>
    message.images
      ? {
          ...message,
          images: message.images.map((image) =>
            typeof image === 'string' ? image : Buffer.from(image).toString('base64')
          )
        }
      : message
  );
}

/**
 * Turn a non-2xx response into a classified error. The body is read once and
 * bounded; `signin_url` (present on Ollama Cloud auth failures) is preserved so
 * the UI can point the user at the sign-in page.
 */
export async function httpError(response: Response): Promise<OllamaHttpError> {
  const text = await response.text();
  let detail = text.slice(0, 500);
  let signinUrl: string | undefined;
  try {
    const body = JSON.parse(text) as { error?: unknown; signin_url?: unknown };
    if (typeof body.error === 'string') detail = body.error;
    if (typeof body.signin_url === 'string') signinUrl = body.signin_url;
  } catch {
    // Preserve bounded non-JSON response text.
  }
  return new OllamaHttpError(
    detail || response.statusText,
    response.status,
    parseRetryAfter(response.headers.get('retry-after')),
    signinUrl
  );
}

export interface PostOptions {
  /** Bearer token; omitted entirely when the host must not receive it. */
  apiKey?: string;
  signal?: AbortSignal;
}

/**
 * POST a JSON body and return the parsed JSON object.
 *
 * Shared by the chat client (non-streaming `/api/chat`, `/api/embed`, …) and
 * the web client (`/api/web_*`, `/api/experimental/web_*`). It enforces the
 * same three rules on both:
 *   - non-2xx → `httpError` (classified, Retry-After aware)
 *   - non-object JSON → explicit error (never a silent `{}`)
 *   - `{ error }` in a 200 body → `OllamaHttpError` with kind 'auth', because
 *     that is exactly how Ollama signals an unusable credential over HTTP 200
 */
export async function postJson(
  endpoint: string,
  body: unknown,
  { apiKey, signal }: PostOptions = {}
): Promise<Record<string, unknown>> {
  const response = await fetch(endpoint, {
    method: 'POST',
    ...(signal ? { signal } : {}),
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw await httpError(response);
  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Ollama endpoint ${endpoint} returned invalid JSON`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(`Ollama endpoint ${endpoint} returned a non-object response`);
  }
  if ('error' in data) {
    // HTTP 200 carrying an error body. JUSTIFICATION for the classification:
    // Ollama signals an unusable CREDENTIAL this way — `{ "error": "unauthorized",
    // "signin_url": ... }` — which is why the old code had to sniff the message
    // text for "401" and why status 200 made it look like a generic fault.
    // It is classified as auth ONLY when the payload actually says so; anything
    // else keeps status 200 and kind 'transport' so a caller cannot mistake an
    // arbitrary backend complaint for "check your API key".
    const detail = String((data as { error: unknown }).error);
    const authLike = /\b(unauthori[sz]ed|unauthenticated|forbidden|invalid[_ ]?(api[_ ]?)?key|api key)\b/i.test(detail);
    throw new OllamaHttpError(
      detail,
      authLike ? 401 : 200,
      undefined,
      'signin_url' in data && typeof data.signin_url === 'string' ? data.signin_url : undefined
    );
  }
  return data as Record<string, unknown>;
}

/**
 * Is this error an abort signal's own DOMException (as opposed to a real
 * transport fault that merely mentions "aborted")?
 *
 * Checked structurally — by `name`, never by message text — because the
 * literal message differs per platform (`This operation was aborted` on
 * Node/undici, `The operation was aborted.`, `The user aborted a request.`,
 * `aborted`) and a message match would silently stop working on a Node bump.
 */
export function isAbortSignalError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Constructors for the two cancellation/timeout error classes, injected rather
 * than imported.
 *
 * `retryChat`/`collectStream` in `chat-helpers.ts` IMPORT `ollama.ts`, which
 * constructs `OllamaHttpClient`. A runtime import of `chat-helpers` from here
 * closes that cycle, and in production the class binding is `undefined` at the
 * moment ollama.ts runs its module-level `new OllamaHttpClient(...)` — the
 * transport then fails to construct at startup ("OllamaHttpClient is not a
 * constructor"). This module therefore stays a LEAF of the engine: callers
 * pass the constructors in, and when they are absent the failure is still
 * reported with a structurally identical error (same `name`, so the existing
 * `isCancellation` / `isTransientError` structural checks keep working).
 */
export interface ConnectFailureErrors {
  cancelled: (cause?: unknown) => Error;
  timedOut: (message: string, reason: 'first-token' | 'liveness', cause?: unknown) => Error;
}

/** `name` values the engine's structural checks recognise (see loop/cancellation.ts). */
const ABORTED_ERROR_NAME = 'StreamAbortedError';
const TIMEOUT_ERROR_NAME = 'StreamTimeoutError';

function namedError(name: string, message: string, cause?: unknown): Error {
  const error = new Error(message, cause === undefined ? undefined : { cause }) as Error & {
    reason?: 'first-token' | 'liveness';
  };
  error.name = name;
  return error;
}

const DEFAULT_CONNECT_FAILURE_ERRORS: ConnectFailureErrors = {
  cancelled: (cause) => namedError(ABORTED_ERROR_NAME, 'Request aborted', cause),
  // Mirror `StreamTimeoutError`'s public shape: consumers other than the
  // injected chat client (health check, rag-*) read `reason` to decide whether
  // to escalate the first-token deadline, so dropping it here silently
  // disabled 20→40→80s escalation for them.
  timedOut: (message, reason, cause) => Object.assign(namedError(TIMEOUT_ERROR_NAME, message, cause), { reason })
};

/**
 * Explain a rejected chat POST instead of re-throwing an opaque `AbortError`.
 *
 * Why this exists: three different events abort the same controller —
 *   - the caller's ESC signal (an intentional cancellation),
 *   - the per-attempt POST deadline in `retryChat` (a connection hang),
 *   - `connect()` itself on a non-2xx / empty-body response,
 * and fetch reports ALL of them as one DOMException whose message is the bare
 * "This operation was aborted". That message names neither the trigger nor the
 * endpoint, so the user saw an unexplained abort in the COLLECT error box while
 /**
 * Explain a rejected chat POST instead of re-throwing an opaque `AbortError`.
 *
 * Why this exists: three different events abort the same controller —
 *   - the caller's ESC signal (an intentional cancellation),
 *   - the per-attempt POST deadline in `retryChat` (a connection hang),
 *   - `connect()` itself on a non-2xx / empty-body response,
 * and fetch reports ALL of them as one DOMException whose message is the bare
 * "This operation was aborted". That message names neither the trigger nor the
 * endpoint, so the user saw an unexplained abort in the COLLECT error box while
 * the actual cause (a POST timeout, or ESC) was invisible.
 *
 * The precedence itself lives in {@link classifyConnectFailure}.
 */
/**
 * The DECISION inside {@link describeConnectFailure}, separated so it can be
 * tested without driving a live POST (the controller is created inside
 * `connect()` and is not exposed, and an abort reason can only be recorded by
 * the controller's owner).
 */
export type ConnectFailureVerdict =
  | { kind: 'cancelled' }
  | { kind: 'timeout' }
  | { kind: 'reason'; reason: unknown }
  | { kind: 'passthrough' };

export function classifyConnectFailure(
  error: unknown,
  callerAborted: boolean,
  requestReason: unknown
): ConnectFailureVerdict {
  // 1. A CANCELLATION MARKER always means cancelled, even when it is also the
  // rejection itself (an Error reason makes `fetch` reject with it verbatim).
  // Checked before the identity rule below, or a shared marker instance would
  // be reported as a descriptive cause.
  if ((requestReason as { causedByCancellation?: unknown } | undefined)?.causedByCancellation === true) {
    return { kind: 'cancelled' };
  }
  // 2. A DESCRIPTIVE reason that is the rejection itself. `retryChat`'s POST
  // deadline aborts the very controller `connect()` sees as its caller signal
  // (`chatController.abort(timeoutError)`), so `callerAborted` is TRUE for a
  // connection hang. Checking the caller flag first therefore reported "the
  // user aborted" for every POST timeout — no retry, no 20→40→80s escalation.
  // When the rejection IS the recorded reason, that reason is the answer:
  // nothing was cancelled by a human, the controller was aborted BY the error.
  if (requestReason !== undefined && error === requestReason) {
    return { kind: 'reason', reason: requestReason };
  }
  // 3. Caller cancellation. Reaching here means the rejection is an
  // independently-shaped value (a DOMException from an abort with no reason),
  // so the caller's flag is the only thing that explains it.
  if (callerAborted) return { kind: 'cancelled' };
  // 4. Anything that is not an abort is the outer normalizer's business.
  if (!isAbortSignalError(error)) return { kind: 'passthrough' };
  // 5. `abort()` sites that carry a descriptive error while the rejection is a
  // bare AbortError (HTTP error, empty body): the reason is more informative
  // than the DOMException.
  if (requestReason instanceof Error && !isAbortSignalError(requestReason)) {
    return { kind: 'reason', reason: requestReason };
  }
  // 6. Not reachable in production today (every production abort records a
  // reason, so rule 2 resolves it first), kept as the safe default for a
  // caller-less abort: report a connection timeout naming the likely cause.
  return { kind: 'timeout' };
}

async function describeConnectFailure(
  error: unknown,
  callerSignal: AbortSignal | undefined,
  requestSignal: AbortSignal,
  errors: ConnectFailureErrors
): Promise<unknown> {
  const verdict = classifyConnectFailure(error, callerSignal?.aborted === true, requestSignal.reason);
  switch (verdict.kind) {
    case 'cancelled':
      return errors.cancelled(error);
    case 'reason':
      return verdict.reason;
    case 'passthrough':
      return error;
    case 'timeout':
      return errors.timedOut(
        'Ollama chat POST was aborted before response headers (no timeout reason recorded; ' +
          'a slow or unreachable Ollama endpoint is the usual cause)',
        'first-token',
        error
      );
  }
}

type StreamChunk = ChatResponse & { error?: string };

/** Malformed complete records are fatal; an EOF-cut record is retryable. */
function parseChunk(line: string, atEof: boolean): StreamChunk {
  try {
    return JSON.parse(line) as StreamChunk;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (atEof) {
      throw new Error(`Ollama stream truncated at EOF; invalid NDJSON (premature close): ${detail}`, { cause: error });
    }
    throw new Error(`Ollama stream returned malformed NDJSON: ${detail}`, { cause: error });
  }
}

export interface OllamaHttpConfig {
  host: string;
  apiKey?: string;
  /**
   * Cancellation/timeout error constructors used to explain an aborted POST.
   * Omit for standalone use (the transport then builds structurally identical
   * errors itself). `ollama.ts` injects its real classes; see
   * {@link ConnectFailureErrors} for why this is injected, not imported.
   */
  errors?: ConnectFailureErrors;
}

export class OllamaHttpClient {
  private readonly host: string;
  private readonly headers: Record<string, string>;
  private readonly errors: ConnectFailureErrors;

  constructor(config: OllamaHttpConfig) {
    this.host = normalizeHost(config.host);
    this.headers = config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
    this.errors = config.errors || DEFAULT_CONNECT_FAILURE_ERRORS;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(`${this.host}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...this.headers, ...init.headers }
    });
    if (!response.ok) throw await httpError(response);
    return response;
  }

  async list(): Promise<ModelListResponse> {
    return (await (await this.request('/api/tags')).json()) as ModelListResponse;
  }

  async show(model: string): Promise<ModelInfo> {
    return (await (
      await this.request('/api/show', {
        method: 'POST',
        body: JSON.stringify({ model })
      })
    ).json()) as ModelInfo;
  }

  async embed(request: EmbedRequest): Promise<EmbedResponse> {
    return (await (
      await this.request('/api/embed', {
        method: 'POST',
        body: JSON.stringify(request)
      })
    ).json()) as EmbedResponse;
  }

  async chat(request: ChatRequest & { stream: true }, signal?: AbortSignal): Promise<OllamaChatStream>;
  async chat(request: ChatRequest & { stream?: false }): Promise<ChatResponse>;
  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse | OllamaChatStream> {
    if (request.stream === true) {
      return OllamaChatStream.connect(this.host, this.headers, request, signal, this.errors);
    }
    const response = await this.request('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ ...request, messages: encodeImages(request.messages), stream: false })
    });
    const data = (await response.json()) as ChatResponse;
    return { ...data, created_at: new Date(data.created_at) };
  }
}

export class OllamaChatStream implements AsyncIterable<ChatResponse> {
  /** Set by abort()/close so cleanup runs exactly once. */
  private closed = false;

  private constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    private readonly controller: AbortController
  ) {}

  static async connect(
    host: string,
    headers: Record<string, string>,
    request: ChatRequest,
    signal?: AbortSignal,
    errors: ConnectFailureErrors = DEFAULT_CONNECT_FAILURE_ERRORS
  ): Promise<OllamaChatStream> {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const body = JSON.stringify({ ...request, messages: encodeImages(request.messages), stream: true });
    let response: Response;
    try {
      response = await fetch(`${normalizeHost(host)}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
        signal: controller.signal
      });
    } catch (error) {
      signal?.removeEventListener('abort', abort);
      throw await describeConnectFailure(error, signal, controller.signal, errors);
    }
    // From here on the POST has produced a Response: the caller's abort
    // listener is no longer needed, and leaving it attached would fire a
    // SECOND (latched, therefore useless) abort on the controller later.
    signal?.removeEventListener('abort', abort);
    if (!response.ok) {
      // Throw the HTTP error ITSELF — `controller.abort(reason)` is a no-op if
      // an abort already latched a different reason, which would discard the
      // 429/401 body and could rethrow a non-Error.
      const httpFailure = await httpError(response);
      controller.abort(httpFailure);
      throw httpFailure;
    }
    if (!response.body) {
      const emptyBody = new Error('Ollama chat returned an empty response body');
      controller.abort(emptyBody);
      throw emptyBody;
    }
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
      reader = response.body.getReader();
    } catch (error) {
      controller.abort(error);
      throw error;
    }
    return new OllamaChatStream(reader, controller);
  }

  /**
   * Stop the stream and release its resources.
   *
   * Idempotent, and it releases the reader even when nobody ever iterated the
   * stream: the previous implementation only released the lock in the
   * iterator's `finally`, so a stream obtained and then abandoned held the
   * body (and its socket) until GC. Cancelling the body lets undici tear the
   * connection down promptly — which is the whole point of an abort.
   */
  abort(reason?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort(reason);
    void this.reader.cancel(reason).catch(() => {
      /* already closed */
    });
    this.releaseLock();
  }

  private releaseLock(): void {
    try {
      this.reader.releaseLock();
    } catch {
      // A pending read() still owns the lock; it settles when cancel() lands.
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ChatResponse> {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await this.reader.read();
        // A cancelled stream is CLOSED, not truncated. Without this the pending
        // read that abort() settles via cancel() would fall through to the EOF
        // branch below and be reported as "Did not receive done or success
        // response in stream" — a generic fault the model might retry — instead
        // of ending the iteration as cancellation.
        if (this.closed) return;
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const chunk = parseChunk(line, false);
          if (chunk.error) throw new Error(chunk.error);
          yield { ...chunk, created_at: new Date(chunk.created_at) };
          if (chunk.done) return;
        }
        if (done) break;
      }
      if (buffer.trim()) {
        const chunk = parseChunk(buffer, true);
        if (chunk.error) throw new Error(chunk.error);
        yield { ...chunk, created_at: new Date(chunk.created_at) };
        if (chunk.done) return;
      }
      throw new Error('Did not receive done or success response in stream');
    } finally {
      if (!this.closed) {
        this.closed = true;
        this.controller.abort();
        this.releaseLock();
      }
    }
  }
}
