/**
 * serve-registry.ts - Module-level access to the ServeHub singleton
 *
 * Keeps the ServeHub reachable from cross-module call sites WITHOUT a static
 * `import { ServeHub } from './serve-hub.js'` — that import is what dragged
 * serve-hub.ts's whole chain (express, vite, @vitejs/plugin-vue, ws, and the
 * sibling serve/* modules) into process boot for every session, including a
 * plain terminal `mycc` run where serve never starts.
 *
 * How it stays lazy: this module imports NOTHING at runtime. The concrete hub
 * reaches it through `registerServeHubFactory()`, which the serve layer calls
 * from `activateServe()` (and from ServeHub itself at construction) — i.e.
 * only once the serve layer has actually been loaded. After that first load,
 * `getServeHub()` is a cheap, synchronous accessor again, so all pre-existing
 * synchronous call sites keep working unchanged.
 *
 * Contract for callers:
 *  - `getServeHub()`      — synchronous. Throws if the serve layer was never
 *                           loaded; correct behaviour, because every legacy
 *                           caller is inside a serve-only code path (a WebUI
 *                           card, a steering drain, a serve shutdown).
 *  - `tryGetServeHub()`   — synchronous, returns null instead of throwing.
 *                           For best-effort paths (auto-state mirroring) that
 *                           must be no-ops when serve is absent.
 *  - `ensureServeHub()`   — async. Dynamic-imports the serve layer, boots the
 *                           singleton, registers the factory, returns it. The
 *                           ONE entry point that materializes the hub.
 */

/**
 * The ServeHub public surface, declared STRUCTURALLY.
 *
 * Deliberately structural rather than `import type { ServeHub }`: a type-only
 * import would still create a module-graph edge in the eyes of tooling and
 * invites a future reader to "simplify" it back into a runtime import — the
 * exact regression this module exists to prevent. Keeping the shape here makes
 * the laziness self-evident and unbreakable.
 *
 * Types cost nothing at runtime (erased by the compiler), so widening this to
 * the full public API is free — and necessary, because ~30 call sites across
 * the loop/context layers use the hub's real methods.
 */
export interface ServeHubLike {
  // ── lifecycle ──
  isRunning(): boolean;
  isRestarting(): boolean;
  start(port: number, host?: string | null): Promise<void>;
  stop(skipAbortInput?: boolean): Promise<void>;
  gracefulShutdown(): Promise<void>;
  restartServe(): Promise<void>;

  // ── addressing ──
  getPort(): number;
  getHost(): string | null;
  getUrl(): string | null;
  getUrls(): { local: string; network: string[] } | null;

  // ── durable transcript wiring ──
  setTranscriptPath(p: string | null): void;
  setUserJournalProvider(cb: ((text: string, source: 'prompt' | 'steer') => void) | null): void;
  journalUserSubmission(text: string, source: 'prompt' | 'steer'): void;

  // ── input bridge ──
  waitForInput(): Promise<string | null>;
  submitInput(text: string): void;
  abortInput(): void;
  rejectInput(): void;
  isInputBlocked(): boolean;

  // ── card bridge ──
  broadcastCard(card: unknown): void;
  waitForCardResponse(cardId: string): Promise<string | null>;
  submitCardResponse(cardId: string, value: string): void;

  // ── steering (hub is the sole writer) ──
  pushSteer(text: string): void;
  onWrapUpSettled(): void;
  resolveSteering(sendIds?: number[]): string[];

  // ── file uploads ──
  pushFileUpload(entry: unknown): void;
  drainFileUploads(): Array<{ filename: string; mimeType: string; data: string; text?: string }>;
  getFileUploads(): unknown[];

  // ── auto / running signals ──
  broadcastAuto(value: boolean): void;
  setAgentRunning(value: boolean): void;
  setAutoStateProvider(provider: (() => boolean) | null): void;
  setEnterAutoProvider(provider: (() => boolean) | null): void;
  getAutoState(): boolean;
  enterAuto(): boolean;

  // ── broadcast ──
  broadcast(type: string, content: string, label?: string, detail?: string, synthetic?: boolean): void;
  broadcastExcept(sender: unknown, type: string, content: string, label?: string, detail?: string): void;
}

/** Factory + instance, both populated only once the serve layer loads. */
let factory: (() => ServeHubLike) | null = null;
let instance: ServeHubLike | null = null;

/**
 * Callbacks queued by shared boot paths that must configure the hub once it
 * exists but must NOT force it into existence (e.g. registering the
 * auto-state / enter-auto providers from the always-run wiring). Populated
 * before the serve layer loads; drained the moment the factory registers.
 */
const readyCallbacks: Array<(hub: ServeHubLike) => void> = [];

/**
 * Register the concrete ServeHub accessor. Called by the serve layer
 * (activate.ts) and by ServeHub's constructor. Idempotent.
 *
 * @param getInstance - returns the process-wide ServeHub singleton
 */
export function registerServeHubFactory(getInstance: () => ServeHubLike): void {
  factory = getInstance;
  instance = null; // resolved lazily from the new factory on first use
  // Flush any configuration callbacks queued before the hub existed. Draining
  // AFTER the factory is set means each callback receives a live hub; a
  // callback that itself resolved the hub would have been a plain accessor
  // call, not a queued one.
  if (readyCallbacks.length > 0) {
    const hub = tryGetServeHub();
    if (hub) {
      const pending = readyCallbacks.splice(0, readyCallbacks.length);
      for (const cb of pending) {
        try { cb(hub); } catch { /* best-effort: a bad provider must not break hub init */ }
      }
    }
  }
}

/**
 * Run `cb` with the ServeHub once the serve layer is loaded — immediately if
 * it already is, otherwise queued until {@link registerServeHubFactory} fires.
 *
 * This is the bridge for shared BOOT paths that must wire hub providers but
 * cannot assume (or force) the hub: e.g. `agent-io.initMain()` registering the
 * auto-state provider, and `wireServeCallbacks()` registering the enter-auto
 * provider. Both run before `activateServe()` in `--serve` mode, so a plain
 * `tryGetServeHub()?.…` would silently drop the provider there. Never triggers
 * a module load — an app that never serves simply leaves the callback parked
 * (harmless: nothing will read the provider).
 */
export function onServeHubReady(cb: (hub: ServeHubLike) => void): void {
  const hub = tryGetServeHub();
  if (hub) { cb(hub); return; }
  readyCallbacks.push(cb);
}


/**
 * The ServeHub singleton, or null when the serve layer has not been loaded.
 * Never triggers a module load — this is what makes state-only reads free.
 */
export function tryGetServeHub(): ServeHubLike | null {
  if (!factory) return null;
  if (!instance) instance = factory();
  return instance;
}

/**
 * The ServeHub singleton. Throws when the serve layer was never loaded, which
 * means a serve-only code path ran without serve ever having started — a
 * programming error, not a recoverable state. Callers on best-effort paths
 * should use {@link tryGetServeHub} instead.
 */
export function getServeHub(): ServeHubLike {
  const hub = tryGetServeHub();
  if (!hub) {
    throw new Error(
      'ServeHub is not available: the serve layer has not been loaded. ' +
      'This accessor lives on a serve-only path — use ensureServeHub() to ' +
      'materialize the hub first, or tryGetServeHub() for a best-effort read.',
    );
  }
  return hub;
}

/**
 * Load the serve layer on demand (dynamic import → the one place serve-hub.ts
 * and its express/vite/ws chain are evaluated), boot the singleton, register
 * the factory, and return the hub. A second call returns the cached instance.
 *
 * This is the ONLY path that pulls express/vite into the process — so it must
 * be called exactly at the genuine serve entry points: `activateServe()`
 * (`/serve` and `--serve`) and ServeHub's own restart path.
 */
export async function ensureServeHub(): Promise<ServeHubLike> {
  if (!factory) {
    const mod = await import('./serve-hub.js');
    registerServeHubFactory(() => mod.ServeHub.getInstance());
  }
  return getServeHub();
}
