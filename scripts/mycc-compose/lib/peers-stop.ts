/**
 * peers-stop.ts — the stop-by-address primitive: `address → sid → pid → signal
 * → confirm`.
 *
 * WHY THIS EXISTS AS ONE MODULE
 * -----------------------------
 * Stopping a mycc-compose peer in user space is a five-step chain with no
 * daemon behind it (unlike docker, mycc-compose has no server holding the live
 * peer set; the launcher IS the orchestrator and its only kill primitive is a
 * signal to a PID). That chain — resolve the durable ADDRESS to the live
 * session id, locate that session's PID, PROVE the PID is really this peer,
 * signal it, then CONFIRM the process actually died — used to be smeared across
 * `stopPeer` (peers-lifecycle), `waitForPeerGone` (peers-state), and the
 * `stopThenQueue` orchestration in `cmd-up`: three places each re-deriving part
 * of the same contract, free to drift.
 *
 * This module is the SINGLE home for that contract. `up`, `down`, and the
 * standalone `mycc-stop` bin all call {@link stopPeerByAddress} — no caller
 * touches a PID, a heartbeat, or a liveness predicate directly.
 *
 * THE ADDRESS (and why it is not a string key)
 * --------------------------------------------
 * A peer is addressed by THREE independent axes: `cwd` (its workdir), `group`,
 * and `name`. These are the two authored halves of the peer's durable identity
 * (`spec.group` and `peers[].name`), plus the workdir that qualifies them. The
 * runtime `--name` flag carries them JOINED as `<group>:<peer>` ONLY because the
 * launcher must pass them as one token and no human types it; that concatenation
 * is a WIRE FORMAT, never an internal key. This module therefore takes the three
 * axes SEPARATELY and compares them COMPONENT-WISE — it never builds or looks up
 * a `<group>:<name>` string. (`resolvePeerForStop` enforces the match: identity
 * entry `name` equals the joined form AND `workDir` equals `cwd`.)
 *
 * RIGID, NO TOLERANCE
 * -------------------
 * A missing / ambiguous entry is NOT "already stopped" — it is UNPROVEN. The
 * primitive fails loud (`refused-not-found` / `refused-ambiguous-identity`)
 * rather than assume the peer is gone. Callers (`mycc-compose up`/`down`) read
 * the verdict and may treat a refusal as PARTIAL SUCCESS across the group — but
 * the primitive itself never silently degrades a refusal into a success.
 */

import {
  resolvePeerForStop,
  readIdentityMap,
  heartbeatPid,
  isSessionHolderDead,
  isPidAlive,
} from './discovery.js';
import { isMyccProcess } from './peers-lifecycle.js';
import { sleep } from './peers-types.js';
import type { Peer } from './peers-types.js';

/**
 * How long {@link stopPeerByAddress} waits for the signaled process to actually
 * die before declaring `still-up`. `process.kill(SIGTERM)` only DELIVERS the
 * signal; the peer's own SIGTERM handler (bg-kill + ServeHub stop) still has to
 * run and the process still has to exit. Confirmation — not delivery — is what
 * proves the stop, so a peer that outlives this window is `still-up` (fail
 * loud), never optimistically "stopped".
 */
export const STOP_CONFIRM_TIMEOUT_MS = 5_000;
const STOP_CONFIRM_POLL_MS = 100;

/** The outcome of a stop attempt. Every non-`stopped`/`already-stopped` value is
 * a REFUSAL or a FAILURE — the caller must not treat "the call returned" as
 * "the peer is down". */
export type StopVerdict =
  /** Signaled and the process was confirmed dead within the window. */
  | 'stopped'
  /** Provably gone already (no live holder, or the recorded PID is dead). */
  | 'already-stopped'
  /** No identity entry matches (cwd, group, name) exactly. UNPROVEN → fail loud. */
  | 'refused-not-found'
  /** >1 identity entry matches the address — the uniqueness invariant is broken;
   * refuse rather than guess. */
  | 'refused-ambiguous-identity'
  /** Heartbeat PID and identity-entry PID disagree — corroboration failed. */
  | 'refused-pid-mismatch'
  /** A PID is recorded but neither the heartbeat nor the entry supplies a
   * usable numeric PID to signal. */
  | 'refused-no-recorded-pid'
  /** The recorded PID is provably recycled (a different process now owns the
   * number) — never signal it. */
  | 'refused-recycled-pid'
  /** The PID's argv does not claim this peer's exact durable name — not our
   * process. */
  | 'refused-not-mycc'
  /** SIGTERM was delivered but the process was still alive at the deadline. */
  | 'still-up';

/**
 * The result of {@link stopPeerByAddress}: the verdict PLUS the runtime session
 * id the primitive resolved for the address (null when none matched).
 *
 * WHY THE SID IS RETURNED: the primitive owns step 1 (RESOLVE), so the caller
 * must not re-derive the sid itself — a second, independent resolution is
 * exactly the kind of split that lets callers drift. `down`, in particular,
 * needs the sid to CULL the now-dead identity entry (the entry is keyed by sid),
 * and after a successful stop the peer's liveness evidence is gone, so the
 * caller could no longer re-resolve it. Returning it keeps resolution in ONE
 * place and hands the caller the exact key it must use.
 */
export interface StopResult {
  verdict: StopVerdict;
  /** The resolved runtime session id, or null when no entry matched. */
  sessionId: string | null;
}

/** True for every verdict that means "the peer is NOT confirmed down". */
export function isRefusal(verdict: StopVerdict): boolean {
  return verdict !== 'stopped' && verdict !== 'already-stopped';
}

/**
 * The address of a peer: three independent axes, never a joined key.
 */
export interface PeerAddress {
  /** Absolute workdir (`--cwd`; callers default it to the process CWD). */
  cwd: string;
  /** The spec/owning group (`spec.group`). */
  group: string;
  /** The bare peer leaf name (`peers[].name`). */
  name: string;
}

export interface StopOptions {
  /** Confirmation window before {@link StopVerdict} `still-up`. Default
   * {@link STOP_CONFIRM_TIMEOUT_MS}. */
  confirmTimeoutMs?: number;
  /** Poll interval while confirming death. */
  pollMs?: number;
}

/**
 * Stop ONE peer identified by its address, owning the whole chain.
 *
 * Steps (each fail-closed; every failure is a distinct refusal verdict):
 *   1. RESOLVE  (cwd, group, name) → live sid, via the component-wise,
 *               workdir-qualified `resolvePeerForStop`. No match →
 *               `refused-not-found`; >1 → `refused-ambiguous-identity`.
 *   2. LOCATE   sid → pid (heartbeat PID cross-checked against the identity
 *               entry PID; disagreement → `refused-pid-mismatch`; neither
 *               present → `refused-no-recorded-pid`).
 *   3. PROVE    the PID is THIS peer — a dead/recycled PID → `already-stopped`
 *               or `refused-recycled-pid`; a live PID whose argv does not claim
 *               the exact durable name → `refused-not-mycc`.
 *   4. SIGNAL   `SIGTERM` (ESRCH at kill time → the peer already exited). The
 *               signal targets the PID resolved in step 2 — the sid is used only
 *               to LOCATE the PID, never to signal.
 *   5. CONFIRM  wait for the PID to be provably gone; timeout → `still-up`.
 *
 * The durable name used to PROVE identity (step 3) is the joined `<group>:<name>`
 * — but that string is constructed HERE, at the boundary, purely because the
 * launched process records its `--name` in that exact wire form. It is never a
 * lookup key.
 */
export async function stopPeerByAddress(
  address: PeerAddress,
  opts: StopOptions = {},
): Promise<StopResult> {
  const { cwd, group, name } = address;
  const confirmTimeoutMs = opts.confirmTimeoutMs ?? STOP_CONFIRM_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? STOP_CONFIRM_POLL_MS;

  // The launched process carries `--name <group>:<name>`; this joined form is a
  // wire value we must produce to compare against the recorded argv/identity, not
  // an internal key. Resolve the address to a synthetic PeerRef the resolver
  // understands: identityName = joined form, workdir = cwd.
  const wireName = `${group}:${name}`;
  const peerRef: Peer = { name, identityName: wireName, workdir: cwd };

  // ── 1. RESOLVE ────────────────────────────────────────────────────────────
  let sid: string | null;
  try {
    sid = resolvePeerForStop(peerRef);
  } catch {
    return { verdict: 'refused-ambiguous-identity', sessionId: null };
  }
  if (!sid) return { verdict: 'refused-not-found', sessionId: null };

  // Steps 2–5 are shared with the sid-native entry point. The identity PROOF
  // (step 3) matches the recorded argv against the peer's durable name — here
  // the address supplies it as the joined wire form.
  return stopResolvedSid(sid, wireName, confirmTimeoutMs, pollMs);
}

/**
 * Stop a peer identified DIRECTLY by its runtime session id (the
 * `mycc-stop --session-id <uuid>` form). This is the SAME chain as
 * {@link stopPeerByAddress} MINUS step 1 (RESOLVE): the sid is given, so there
 * is nothing to resolve by address. Steps 2–5 (locate the PID, PROVE it is this
 * peer, SIGNAL, CONFIRM) are identical and shared.
 *
 * The identity PROOF (step 3) reads the durable name the identity entry records
 * for this sid — a sid identifies the run, and the launched process's argv
 * claims that peer's name, so we match against the recorded name rather than a
 * caller-supplied one. When the entry records no name, there is nothing to prove
 * against and the stop is refused (`refused-not-mycc`) rather than signal an
 * unverifiable process.
 *
 * The caller is responsible for validating the sid's SHAPE (the CLI rejects a
 * malformed `--session-id` before calling this). This function treats the sid as
 * opaque and simply looks it up.
 */
export async function stopPeerBySid(
  sessionId: string,
  opts: StopOptions = {},
): Promise<StopResult> {
  const confirmTimeoutMs = opts.confirmTimeoutMs ?? STOP_CONFIRM_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? STOP_CONFIRM_POLL_MS;

  const entry = readIdentityMap()[sessionId];
  if (!entry) return { verdict: 'refused-not-found', sessionId };
  // The durable name the entry records is what the process's argv must claim.
  // No recorded name → cannot prove identity → refuse.
  const wireName = typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : null;
  if (!wireName) return { verdict: 'refused-not-mycc', sessionId };

  return stopResolvedSid(sessionId, wireName, confirmTimeoutMs, pollMs);
}

/**
 * Steps 2–5 of the stop chain, given an already-resolved sid and the durable
 * `wireName` (the joined `<group>:<peer>` the process's argv must claim). Shared
 * by {@link stopPeerByAddress} (which resolves first) and {@link stopPeerBySid}
 * (which is handed the sid). Fail-closed at every step.
 */
function stopResolvedSid(
  sid: string,
  wireName: string,
  confirmTimeoutMs: number,
  pollMs: number,
): Promise<StopResult> {
  // ── 2. LOCATE ─────────────────────────────────────────────────────────────
  const hbPid = heartbeatPid(sid);
  const entry = readIdentityMap()[sid];
  const entryPid = typeof entry?.pid === 'number' ? entry.pid : undefined;
  if (typeof hbPid === 'number' && typeof entryPid === 'number' && hbPid !== entryPid) {
    return Promise.resolve({ verdict: 'refused-pid-mismatch', sessionId: sid });
  }
  const pid = typeof hbPid === 'number' ? hbPid : entryPid;
  if (typeof pid !== 'number') {
    return Promise.resolve({ verdict: 'refused-no-recorded-pid', sessionId: sid });
  }

  // ── 3. PROVE ──────────────────────────────────────────────────────────────
  // A dead or provably recycled PID means the original peer is gone. Never
  // signal the unrelated process that happens to reuse its numeric PID.
  if (isSessionHolderDead(sid)) {
    return Promise.resolve({
      verdict: isPidAlive(pid) ? 'refused-recycled-pid' : 'already-stopped',
      sessionId: sid,
    });
  }
  // A still-plausible PID is not enough by itself; its argv must claim this
  // peer's exact durable name. Unknown command-line identity fails closed.
  if (!isMyccProcess(pid, wireName)) {
    return Promise.resolve({ verdict: 'refused-not-mycc', sessionId: sid });
  }

  // ── 4. SIGNAL ─────────────────────────────────────────────────────────────
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ESRCH') return Promise.resolve({ verdict: 'already-stopped', sessionId: sid });
    // Any other kill failure is a refusal, not a stop.
    return Promise.resolve({ verdict: 'refused-not-mycc', sessionId: sid });
  }

  // ── 5. CONFIRM ────────────────────────────────────────────────────────────
  // The signal was DELIVERED, not necessarily OBSERVED. Prove death: poll the
  // PID until it is gone, bounded by the window. `isPidAlive` is the same
  // liveness primitive the launch path uses, so "gone" means the same here.
  return (async (): Promise<StopResult> => {
    const deadline = Date.now() + confirmTimeoutMs;
    for (;;) {
      if (!isPidAlive(pid)) return { verdict: 'stopped', sessionId: sid };
      if (Date.now() >= deadline) return { verdict: 'still-up', sessionId: sid };
      await sleep(pollMs);
    }
  })();
}