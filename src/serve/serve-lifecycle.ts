/**
 * serve-lifecycle.ts — the serve stack's LIFECYCLE STATE MACHINE, extracted
 * from serve-hub.ts.
 *
 * WHY THIS MODULE EXISTS: `start()` / `stop()` / `restartServe()` /
 * `gracefulShutdown()` are one interlocking state machine spread across ~450
 * lines of the hub. Reading them in the hub required holding Express/Vite/WS
 * setup in the same screenful as the `running` / `agentRunning` / `restarting`
 * / `stopping` transitions — the transitions were the hard part and they were
 * buried under the plumbing. This module owns ONLY the transitions; the hub
 * owns the plumbing.
 *
 * OWNERSHIP CONTRACT: `ServeLifecycleState` is the SOLE reader and writer of
 * the four lifecycle booleans. The hub exposes them to the machine through a
 * read-only {@link LifecycleHost} view (state is passed by reference, plumbing
 * by callback), so a transition can never be executed in two places. Nothing
 * here touches Express, Vite, the WS server, the client registry, the input
 * bridge or the steering manager directly — every side effect is a host hook.
 *
 * The observable ORDER of transitions is load-bearing and is why they live
 * together (each item is pinned by a test; see tests/serve/*):
 *   - stop():  running=false FIRST, so isRunning() answers false for every
 *              hook below it (abortInput, clients.closeAll, disposeStack).
 *   - stop():  the WebUI-down publish and the steering wipe are GATED on
 *              !restarting — a restartServe() recycle must be INVISIBLE to the
 *              loop; only a genuine shutdown publishes `down`.
 *   - restartServe(): `restarting` is set BEFORE stop() (which flips running)
 *              and cleared in a finally AFTER start() flipped it back, so
 *              WebInputProvider's three-way guard reads "still mine" for the
 *              whole window instead of "serve is gone → headless exit".
 *   - restartServe() failure: publish `down` AND abort the input wait — a
 *              failed recycle can never deliver on the wait it preserved.
 *   - gracefulShutdown(): stop(skipAbortInput=true) and abortInput() LAST, so
 *              the restore message prints BEFORE the fallback `agent >>`
 *              prompt (the "ESC quit serve" race).
 */

/** The mutable lifecycle flags. Owned by the machine, held by the hub. */
export interface LifecycleState {
  /** `isRunning()` — flipped false FIRST in stop(), true LAST in start(). */
  running: boolean;
  /** State-machine-driven processing flag (idle PROMPT/AWAIT → false). */
  agentRunning: boolean;
  /** Re-entrancy guard for stop(). */
  stopping: boolean;
  /** True while restartServe() recycles the stack in-process on the same port. */
  restarting: boolean;
  /** Port the current/last stack was bound to (0 = never started). */
  port: number;
  /** Explicit `--host` binding; null = localhost-only. */
  host: string | null;
  /**
   * The published WebUI-up state (mirrors `isWebUiUp()`), kept in the state
   * record so the two publish sites below have exactly one writer.
   */
  webUiUp: boolean;
}

/**
 * The hub's side of the contract: plumbing the transitions drive, plus the
 * read-only accessors the transitions consult.
 */
export interface LifecycleHost {
  /** Build/bind Express + Vite + WS and resolve once listening. */
  startStack(port: number, host: string | null): Promise<void>;
  /** Release HTTP/Vite/WS/peer-wire WITHOUT any lifecycle state transition. */
  disposeStack(): Promise<void>;
  /** Publish the serve-layer STOP seam (`setWebUiUp(false)`). */
  publishWebUiDown(): void;
  /** Tell the parent the serve mode is inactive (restores stdin filtering). */
  notifyParentInactive(): void;
  /** Resolve a blocked waitForInput() with null + drain card resolvers. */
  abortInput(): void;
  cancelDisconnectTimer(): void;
  closeAllClients(): void;
  /** Terminal steering wipe (skipped mid-recycle). */
  clearSteering(): void;
  /** Empty the serve-lifetime message log. */
  resetMessageLog(): void;
  /**
   * Drop the ephemeral file-upload buffer.
   *
   * Sits in the same teardown group as {@link resetMessageLog}: a file attached
   * just before a stop / WebUI restart must not be drained into the FIRST turn
   * of the NEXT session (HEAD's `stop()` assigned `this.fileUploadQueue = []`
   * there). Deliberately NOT run on the start() failure path — HEAD did not
   * reset the buffer there either.
   */
  resetFileUploads(): void;
  /** Subscribe to steering mutations (resolves once per start()). */
  subscribeSteering(): void;
  /** Tear down the steering subscription (paired with subscribeSteering). */
  unsubscribeSteering(): void;
  /** Re-wire output/result mirroring after a successful recycle. */
  rewireOutputMirroring(): void;
  /** Publish the serve-layer UP seam (`setWebUiUp(true)`). */
  publishWebUiUp(): void;
  log(msg: string): void;
  printRestored(): void;
}

export class ServeLifecycleState {
  constructor(
    private readonly state: LifecycleState,
    private readonly host: LifecycleHost
  ) {}

  /** Whether the serve stack is mid-restart (stop(true) → start(same port)). */
  isRestarting(): boolean {
    return this.state.restarting;
  }

  isRunning(): boolean {
    return this.state.running;
  }

  /**
   * Start the stack. Re-entrant-safe: an already-running hub is a no-op (so a
   * double `--serve` cannot bind twice). The steering subscription is armed
   * BEFORE the stack comes up so a note queued during startup is still
   * reported; the observer itself is gated on isRunning().
   */
  async start(port: number, host?: string | null): Promise<void> {
    if (this.state.running) return;
    this.state.port = port;
    this.state.host = host ?? null;

    // Subscribe to steering mutations as the stack comes up, so a note queued
    // during startup is still reported. Unsubscribed in stop(), so a
    // restartServe() recycle re-subscribes exactly once.
    this.host.unsubscribeSteering();
    this.host.subscribeSteering();

    try {
      await this.host.startStack(port, this.state.host);
      this.host.resetMessageLog();
      this.state.running = true;
    } catch (err) {
      // STARTUP-FAILURE cleanup: a start() that throws mid-initialization has
      // partially-initialized the hub. Release those resources now so a later
      // retry does not overwrite live handles and leak them. Must NOT run the
      // full stop() state transitions — restartServe()'s own catch owns those.
      this.state.running = false;
      await this.host.disposeStack();
      this.host.resetMessageLog();
      // Steering observer teardown for the subscription armed above. Without
      // it a failed start (e.g. an EADDRINUSE retry) leaks one observer until
      // the next successful start() — the "paired with stop()" contract this
      // method's subscription comment states. Idempotent: the hub's
      // unsubscribeSteering hook nulls its handle, so a retry's
      // unsubscribe-subscribe pair is unaffected.
      this.host.unsubscribeSteering();
      throw err;
    }
  }

  /**
   * Tear down the serve stack. skipAbortInput=true (gracefulShutdown) defers
   * abortInput() to the caller so the restore message prints first — calling
   * it here would let WebInputProvider draw `agent >>` before the message,
   * clobbering the prompt (the "ESC quit serve" bug).
   */
  async stop(skipAbortInput = false): Promise<void> {
    if (this.state.stopping) return; // re-entrancy guard
    this.state.stopping = true;
    try {
      // running=false FIRST: isRunning() must answer false for everything below.
      this.state.running = false;
      this.state.agentRunning = false;
      this.publishDownUnlessRecycling();
      this.host.notifyParentInactive();
      if (!skipAbortInput) {
        this.host.abortInput();
      }
      this.host.cancelDisconnectTimer();
      this.host.closeAllClients();
      await this.host.disposeStack();
      this.host.resetMessageLog();
      // Lifecycle wipe: notes are wiped ONLY on terminal teardown. restartServe()
      // begins the recycle BEFORE calling stop(true) so this clear is skipped
      // mid-recycle — notes survive a 重启 exactly like the pending resolver.
      if (!this.isRecycling()) {
        this.host.clearSteering();
      }
      // The ephemeral upload buffer belongs to this same teardown group: HEAD's
      // stop() dropped it right here, and without that a file attached just
      // before a stop / WebUI restart was drained into the FIRST turn of the
      // NEXT session. Same position as HEAD (after the steering wipe, before
      // the observer teardown) so the documented transition ORDER is unchanged.
      this.host.resetFileUploads();
      // Steering observer teardown (paired with the start() subscription). A
      // restartServe() recycle re-subscribes in start(), so this must happen on
      // BOTH paths or the recycled hub would emit twice per mutation.
      this.host.unsubscribeSteering();
    } finally {
      this.state.stopping = false;
    }
  }

  /** Called by: exit button, disconnect timeout, ESC neglection handler. */
  async gracefulShutdown(): Promise<void> {
    this.host.cancelDisconnectTimer();
    // stop(skipAbortInput=true): tear down servers + running=false, but defer
    // abortInput() to the tail so the restore message prints BEFORE the
    // fallback `agent >>` prompt (the "ESC quit serve" race).
    //
    // The tail is in a finally: `printRestored()` unwires output/result
    // mirroring (`setOutputCallback(null)` / `setResultCallback(null)`) and
    // `abortInput()` unblocks the terminal wait — if disposeStack() throws out
    // of stop(), BOTH must still run or mirroring stays wired to a disposed
    // stack and the terminal wait hangs forever. The nesting is deliberate:
    // print-then-abort is the documented ORDER, and abortInput() must also
    // survive a throw from printRestored() itself.
    try {
      await this.stop(true);
    } finally {
      try {
        this.host.printRestored();
      } finally {
        this.host.abortInput(); // now unblock the fallback terminal prompt
      }
    }
  }

  // ── Recycle gates ──
  //
  // Both predicates read the SAME flag through one method so the stop() seam
  // has exactly one statement of "am I mid-recycle?" — the down-publish and the
  // steering wipe must never disagree about it (they are the two visible
  // effects of a recycle, and a mismatch is exactly the spurious stop/start
  // transition the loop's edge-triggered report would fire on).

  /** True while restartServe() is recycling the stack. */
  private isRecycling(): boolean {
    return this.state.restarting;
  }

  /** Publish the WebUI-down seam — GATED: a recycle must stay INVISIBLE. */
  private publishDownUnlessRecycling(): void {
    if (!this.isRecycling()) this.host.publishWebUiDown();
  }

  /** Enter a recycle: flag first, so every stop() seam below sees it. */
  private beginRecycle(): void {
    this.state.restarting = true;
    // Drop a stale stop() re-entrancy flag. restartServe()'s stop(true) clears
    // it in its own finally on the happy path, but a FAILED start() leaves the
    // recycle without a completed stop(); without this a later terminal stop()
    // would return early and leave the servers bound.
    this.state.stopping = false;
  }

  /**
   * Recycle the HTTP/Vite/WS stack in-process on the same port (the 重启
   * button in persistent mode). Distinct from gracefulShutdown(): this does
   * NOT unblock the input resolver, does NOT print the restored message, and
   * does NOT publish a down transition on the happy path.
   *
   * `restarting` is set BEFORE stop() (which flips running to false) and
   * cleared in a finally AFTER start() flips it back to true.
   */
  restartServe(): Promise<void> {
    if (this.state.restarting) return Promise.resolve(); // re-entrancy guard
    const port = this.state.port;
    const host = this.state.host;
    // `restarting` is set BEFORE stop() so stop()'s down-publish and steering
    // wipe are skipped — a recycle must be INVISIBLE to the loop — and before
    // start() so a bind retry reads as "still mine, keep waiting".
    this.beginRecycle();
    // DELIBERATELY NOT `async`: the flag must be armed SYNCHRONOUSLY, before the
    // first await, or a caller that only reaches the first microtask (every
    // test, and any concurrent lifecycle probe) observes `restarting === false`
    // mid-recycle and takes the "serve is gone" branch.
    return this.runRecycle(port, host);
  }

  /**
   * The recycle body. Called from {@link restartServe} with `restarting`
   * ALREADY armed, so every `stop()` seam inside sees the recycle.
   *
   * The whole body — including the failure branch — runs inside the try, and
   * `restarting` is cleared in the finally BEFORE anything can observe it. A
   * failed recycle therefore still publishes `down`, still settles the
   * outstanding input wait, and still REJECTS to its caller (the rejection is
   * what tells a daemon the webui did not come back).
   */
  private async runRecycle(port: number, host: string | null): Promise<void> {
    let failure: unknown = null;
    try {
      await this.stop(true);
      await this.start(port, host);
      this.host.rewireOutputMirroring();
      this.host.publishWebUiUp();
      this.host.log(`Web UI restarted on port ${port}`);
    } catch (err) {
      failure = err;
    } finally {
      this.state.restarting = false;
    }
    if (failure !== null) {
      // A FAILED restart must NOT leave the holder reading "up": stop(true)
      // skipped the down-publish (it runs mid-recycle) and start() throwing
      // skipped publishWebUiUp(). Publish the down state now — after the
      // recycle flag is clear, so the seam is not itself suppressed — then
      // wake the outstanding input wait: stop(true) preserved it, but a failed
      // recycle can never deliver on it, so resolving with null is the only
      // honest answer.
      this.host.publishWebUiDown();
      this.host.abortInput();
      throw failure;
    }
  }
}
