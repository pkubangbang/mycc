/**
 * steering-manager.ts - loop-homed singleton for WebUI steering notes
 *
 * WebUI mid-task steering (notes sent from the browser while the agent works)
 * used to live as an incidental field on ServeHub (`steeringQueue`). That
 * placement caused four defects:
 *
 * 1. 停止-button race: ServeHub.stop() wiped the queue, so a note sent in the
 *    stop window (停止 → wrap-up → PROMPT) was silently destroyed while the
 *    frontend buffer kept showing it.
 * 2. Latent boundary defect: loop states consumed steering via
 *    getServeHub() — a side-effect-instantiating lazy singleton — from inside
 *    src/loop/**, the wrong dependency direction for pure reads.
 * 3. /history payload type mismatch: the hub serialized note TEXTS, while the
 *    frontend types steeringBuffer as {id,text}[] — ids were lost on reload.
 * 4. Ownership was implicit: nothing enforced that only the hub (owner of the
 *    parallel WS input) writes, though only-hub-writes is the safety property
 *    peer-wire verification relies on (peer frames never inject steering).
 *
 * This manager is the single owner of the note queue. ServeHub is the sole
 * WRITER (only it sees the 'steer' WS frame); loop states are READERS via
 * peekTexts/peekNotes/drainNotes/isNonEmpty. Serve → loop imports are fine
 * (the hub imports this module); loop → serve-registry for steering reads is
 * banned (see src/tests/loop/import-boundary.test.ts).
 *
 * Parked-PROMPT delivery policy (`takeForDelivery`): a parked PROMPT loop
 * cannot poll — `waitForInput` is a blocking IPC wait with no executor
 * between arm and the next inbound event. Delivery therefore rides three
 * instants (note-arrival write-point in pushSteer, park-arm point in
 * waitForInput, wrap-up settle wake in esc-wrap-up), each re-running the same
 * pure boolean check after whichever event lands last. See
 * docs/archived/steering-manager-plan.md §3-§5.
 *
 * Pure, framework-free, side-effect-free: no imports at all, so it can be
 * unit-tested in the node-environment Vitest suite WITHOUT importing the
 * heavy serve-hub.ts module graph (Express + Vite + agent-io).
 *
 * ── Revisioned snapshots (the identity fix) ──────────────────────────────
 * The WebUI used to reconstruct this queue from DELTA events: `steer-echo`
 * (add one, carries an id) and `steer-flush` (clear all, carries NOTHING).
 * A clear-all event cannot be attributed to a specific drain, so the client
 * had to GUESS whether its own `steer-resolve` had landed (see the deleted
 * src/web/src/resolve-guard.ts) and an in-flight /history snapshot could
 * re-insert an already-resolved note.
 *
 * Every mutation now bumps a monotonic `revision` and notifies subscribers
 * with the WHOLE queue ({revision, notes}). The hub registers ONE observer
 * (ServeHub.start) and broadcasts it as `steer-state`; the client adopts a
 * snapshot iff `revision > lastAdopted`. Consequences:
 *   - drains need not name what they consumed (the snapshot says what
 *     SURVIVED), so attribution is structural rather than inferred;
 *   - a stale /history snapshot carries an older revision and is rejected;
 *   - the resolve guard, id-deduping on echoes, and the `steer:<length>`
 *     ETag all disappear (length cannot see id churn; revision can).
 * The revision is per-process: a new serve process starts at 0, so a client
 * that outlives the process must reset its adopted revision (see
 * fetchConfig's session-change branch in main.ts).
 */

export interface SteeringNote {
  id: number;
  text: string;
}

/** The queue plus its version — the unit of client adoption. */
export interface SteeringSnapshot {
  revision: number;
  notes: SteeringNote[];
}

/** Observer signature: called once per mutation with the post-mutation state. */
export type SteeringListener = (snapshot: SteeringSnapshot) => void;

/**
 * Resolve a steering queue with positive "boomerang" semantics:
 *
 * - `sendIds` declares which note ids to SEND.
 * - Every note NOT in `sendIds` is implicitly DISCARDED.
 * - The WHOLE queue is drained atomically (returned notes are the selected
 *   subset in queue order), so a later peek sees an empty queue and cannot
 *   re-synthesize the same notes.
 *
 * Filter-based, NOT id-de-duplicated: when two notes share an id, a single
 * sendIds entry selects BOTH (pinned by the duplicate-id test, A4 contract).
 *
 * @param queue - the current ordered queue (caller replaces it with `[]`).
 * @param sendIds - ids to send; empty/omitted means "discard all".
 * @returns the selected notes in queue order (empty when nothing selected).
 */
export function resolveSteeringQueue(
  queue: SteeringNote[],
  sendIds: number[] = [],
): SteeringNote[] {
  return queue.filter((n) => sendIds.includes(n.id));
}

/**
 * Join selected steering notes for submission. Blank-line separated so each
 * note remains visually distinct in the synthesized/echoed text.
 */
export function joinSteeringNotes(notes: SteeringNote[]): string {
  return notes.map((n) => n.text).join('\n\n');
}

export class SteeringManager {
  /** Ordered notes; ids are monotonic within the process (never reset by clear()). */
  private notes: SteeringNote[] = [];
  private idCounter = 0;
  /**
   * Monotonic queue version. Bumped by EVERY mutation (add / drain / resolve
   * / clear) so a client can order snapshots against each other without
   * relying on arrival order — the whole point of the revisioned-snapshot
   * protocol (see the header). Never reset, not even by clear().
   */
  private revision = 0;
  /** Registered observers (the hub registers exactly one, at start()). */
  private listeners = new Set<SteeringListener>();

  /** Current queue + version. The client-side unit of adoption. */
  snapshot(): SteeringSnapshot {
    return { revision: this.revision, notes: this.notes.slice() };
  }

  /** Current version only (read by the /history ETag composition). */
  getRevision(): number {
    return this.revision;
  }

  /**
   * Register a mutation observer. Returns an unsubscribe function.
   *
   * Emission is INTRINSIC to mutation, deliberately: the previous design made
   * each drain site hand-broadcast `steer-flush`, so a new drain site added
   * later would silently forget to notify anyone. Callers of the mutators
   * cannot forget a listener they never call.
   *
   * A throwing listener is isolated — one bad observer must not break a
   * mutation (the queue has already been mutated by then; the emit is a
   * report, not part of the transaction).
   */
  onChange(listener: SteeringListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Bump the revision and report the post-mutation snapshot to all observers. */
  private emit(): void {
    this.revision++;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try { listener(snapshot); } catch { /* isolate observer failures */ }
    }
  }

  /**
   * Append a note, minting its stable id. Sole entry point for new notes —
   * only ServeHub (owner of the WS 'steer' frame) calls it.
   */
  addNote(text: string): SteeringNote {
    const note: SteeringNote = { id: ++this.idCounter, text };
    this.notes.push(note);
    this.emit();
    return note;
  }

  /**
   * Atomically resolve the queue with boomerang semantics. The whole queue
   * drains in one step: `selected` carries the notes to submit, `discarded`
   * carries the implicitly-dropped remainder (kept for source-side verbose
   * logging in the hub). Duplicate ids are not de-duplicated (A4).
   */
  resolveBoomerang(sendIds: number[] = []): { selected: SteeringNote[]; discarded: SteeringNote[] } {
    const drained = this.drainNotes();
    const selected = resolveSteeringQueue(drained, sendIds);
    const selectedSet = new Set(selected);
    const discarded = drained.filter((n) => !selectedSet.has(n));
    return { selected, discarded };
  }

  /** Peek note objects ({id,text}) without consuming. */
  peekNotes(): SteeringNote[] {
    return this.notes.slice();
  }

  /** Peek note texts without consuming (PROMPT synthesis gate). */
  peekTexts(): string[] {
    return this.notes.map((n) => n.text);
  }

  /**
   * Atomically take all notes; queue becomes empty. A no-op drain does NOT
   * emit — an empty queue has no state change to report (a drain site runs on
   * every COLLECT, and a pointless emit per turn would spam every client).
   */
  drainNotes(): SteeringNote[] {
    if (this.notes.length === 0) return [];
    const drained = this.notes;
    this.notes = [];
    this.emit();
    return drained;
  }

  /** Non-consuming emptiness flag (awaitTeammates / background peek polls). */
  isNonEmpty(): boolean {
    return this.notes.length > 0;
  }

  /**
   * Parked-delivery decision core. Returns the drained notes only when the
   * loop is parked waiting for input AND the wrap-up window is closed;
   * returns null (hold) otherwise — the caller then defers to a later seam.
   *
   * Matrix (docs/archived/steering-manager-plan.md §3):
   *   empty queue                        → null (nothing to deliver)
   *   !isParked  && !wrapUpInFlight      → null (hold; turn drains collect)
   *   !isParked  &&  wrapUpInFlight      → null (hold)
   *    isParked  && !wrapUpInFlight      → drained notes (deliver)
   *    isParked  &&  wrapUpInFlight      → null (hold; wake seam delivers)
   *
   * Hold-during-wrapup justification: submitting an input while the wrap-up
   * promise is in flight risks evaluateWrapUp → rollback, whose wrap-up-mark
   * truncation would delete the just-appended query message.
   */
  takeForDelivery(isParked: boolean, wrapUpInFlight: boolean): SteeringNote[] | null {
    if (this.notes.length === 0) return null;
    if (!isParked || wrapUpInFlight) return null;
    return this.drainNotes();
  }

  /** Wipe the queue. Lifecycle-only: terminal stop / input fallback (A2) —
   * never called by restartServe() or any park-time seam.
   *
   * Emits even when already empty (unlike drainNotes): clear() is an
   * authoritative "queue is empty" statement, and a client that missed
   * earlier events can then be re-synced by the resulting snapshot. */
  clear(): void {
    this.notes = [];
    this.emit();
  }
}

/**
 * Process-wide lazy singleton. Always safe to call — the manager is a
 * stateless-except-data base component with no ports and no registration.
 */
let singleton: SteeringManager | null = null;

export function getSteeringManager(): SteeringManager {
  if (!singleton) singleton = new SteeringManager();
  return singleton;
}