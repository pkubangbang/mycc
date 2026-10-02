/**
 * mycc-compose-up-pipeline.test.ts — the P1-1 regression suite: `sync`
 * (cmdUp with allowStop:false) must never recycle a live+matching peer with
 * `renew:"always"` — the cron path is non-destructive ("up minus destructive
 * stops", docs/peer-topology.md §6.2). Before this suite the always-branch
 * ran stopPeer+restart regardless of allowStop, so every cron tick bounced
 * such a peer.
 *
 * Round-3 design (issues #7/#8/#14): discovery.ts pins DISCOVERY_DIR /
 * IDENTITY_FILE / HEARTBEAT_DIR at MODULE LOAD, so ANY static import of a
 * compose-lib module resolves the real ~/.mycc-store paths before
 * beforeEach can set MYCC_DISCOVERY_DIR. The old suite imported discovery
 * statically and seeded through a mix of real-store identity writes and
 * env-path heartbeat writes — the seeds were invisible to the very code
 * under test, isPeerRunning stayed false, and cmdUp's §5 liveness-wait
 * burned its full 30s deadline per test → three 10s timeouts.
 *
 * Fix, per issue #8's acceptance:
 *   - NO static import of any compose-lib module; everything is dynamically
 *     imported AFTER the env override is set (per test, after vi.resetModules).
 *   - Seeds go through the dynamically-imported module's own exported
 *     constants (DISCOVERY_DIR/HEARTBEAT_DIR) so reads and writes can never
 *     disagree about the store root.
 *   - A fresh random SID per test — no fixed sid shared across suites, so a
 *     leak cannot poison another suite.
 *   - launchPeer/stopPeer are spied on the freshly imported peers.js barrel
 *     namespace (the exact module cmd-up.ts imports its bindings from); the
 *     spy is re-taken per runCmdUpAllowStop call against that call's freshly
 *     re-evaluated graph. Decisions are still exercised through the REAL
 *     findMatchingLiveEntry/argsMatch/isPeerRunning pipeline.
 *   - process.exit is stubbed: cmdUp "returns" from inside its exit call and
 *     the spy records the code instead of killing the vitest worker; rows are
 *     captured through process.stdout.write (cli.ts out() writes there).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

type Discovery = typeof import('../../scripts/mycc-compose/lib/discovery.js');

const ARGS = '--auto --skip-healthcheck';

let tempDir = '';
let specFile = '';
let SID = '';
/** The discovery module dynamically imported for the CURRENT test. */
let d: Discovery | null = null;

/**
 * Round-4 (issue #9): the hoisted vi.mock factory WAS the bug. A mock
 * factory runs once per file and its result — including the importOriginal'd
 * module graph, whose discovery.js pins DISCOVERY_DIR at load time — is
 * cached in the MOCKS registry, which vi.resetModules() does NOT clear (it
 * only clears the modules registry). Test 1's graph therefore stayed bound
 * to test 1's temp store: in tests 2/3 cmdUp's chain saw isPeerRunning=false
 * (deleted dir) and decided "mismatch", while fresh direct imports saw the
 * seeds. Fix: no vi.mock at all — spy on the freshly imported barrel
 * namespace (dynamic import AFTER the env override and BEFORE cmd-up.js is
 * ever imported, so whatever binding cmd-up takes captures the spied
 * functions), and let the per-test registry reset re-evaluate the actual
 * graph under the current override.
 */
let peersMod: typeof import('../../scripts/mycc-compose/lib/peers.js');
let launchPeerSpy: ReturnType<typeof vi.fn>;
let stopPeerSpy: ReturnType<typeof vi.fn>;

/** Seed identity.json with the entry a real registered peer would have. */
function seedIdentity(): void {
  const map: Record<string, unknown> = {};
  map[SID] = {
    sessionId: SID,
    pid: process.pid,
    workDir: tempDir,
    args: ARGS,
    startedAt: Date.now(),
  };
  d!.writeIdentityMap(map as never);
}

/** Fresh heartbeat at the DISCOVERY-side path (never a re-derived path). */
function seedHeartbeat(sid: string): void {
  const hbFile = path.join(d!.HEARTBEAT_DIR, `${sid}.json`);
  fs.mkdirSync(path.dirname(hbFile), { recursive: true });
  fs.writeFileSync(
    hbFile,
    JSON.stringify({ heartbeats: [Date.now()], briefs: [], pid: process.pid }),
  );
}

/** A minimal valid spec: one pinned peer with the given renew policy. */
function writeSpec(renew: 'always' | 'onMismatch'): void {
  fs.writeFileSync(specFile, JSON.stringify({
    group: 'grp',
    peers: [{ name: 'always-peer', workdir: tempDir, args: ARGS, sessionId: SID, renew }],
    channels: [],
  }, null, 2));
}

/**
 * Run cmdUp with `out()` captured via process.stdout.write (cli.ts writes
 * there) and process.exit stubbed to "return" out of cmdUp, recording the
 * exit code without killing the vitest worker.
 */
async function runCmdUpAllowStop(allowStop: boolean): Promise<{ rows: string[]; exitCode: unknown }> {
  // Import + spy the barrel FIRST, fresh under this call's module graph —
  // BEFORE cmd-up.js is imported, so its bound launchPeer/stopPeer capture
  // the (spied) namespace functions. Test 3 runs this twice; spyOn on a
  // freshly re-evaluated graph each time means no stacked spies.
  peersMod = await import('../../scripts/mycc-compose/lib/peers.js');
  launchPeerSpy = vi.spyOn(peersMod, 'launchPeer').mockImplementation(
    async (peer: { sessionId?: string | null }) => {
      // The spy registers the fake peer in the identity map exactly as a
      // real launch+register() would, so the post-launch liveness wait
      // resolves on its first poll.
      const sid = peer.sessionId ?? SID;
      const map = d!.readIdentityMap();
      map[sid] = {
        sessionId: sid,
        pid: process.pid,
        workDir: tempDir,
        args: ARGS,
        startedAt: Date.now(),
      };
      d!.writeIdentityMap(map as never);
      seedHeartbeat(sid);
      return { ok: true, pid: process.pid } as never;
    },
  );
  stopPeerSpy = vi.spyOn(peersMod, 'stopPeer').mockReturnValue('stopped' as never);
  // Dynamic import AFTER the env override: every module in this graph —
  // cmd-up, the barrel (already spied), peers-state, discovery — now sees
  // the overridden MYCC_DISCOVERY_DIR at load time.
  const mod = await import('../../scripts/mycc-compose/lib/cmd-up.js');
  const cmdUp = (mod as { cmdUp: (file: string, opts: { allowStop: boolean }) => Promise<void> }).cmdUp;
  const rows: string[] = [];
  let exitCode: unknown = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    rows.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null | undefined) => {
    exitCode = code;
    throw new Error(`__cmd_up_exit__:${String(code)}`);
  }) as typeof process.exit);
  try {
    await cmdUp(specFile, { allowStop });
  } catch (err) {
    // cmdUp "returns" through our exit stub — ignore only that sentinel.
    if (!(err instanceof Error) || !(err as Error).message.startsWith('__cmd_up_exit__')) throw err;
  } finally {
    vi.restoreAllMocks();
  }
  return { rows, exitCode };
}

beforeEach(() => {
  vi.resetModules();
  d = null as unknown as Discovery;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-up-'));
  // Override BEFORE any compose-lib import of this test's module graph.
  process.env.MYCC_DISCOVERY_DIR = path.join(tempDir, 'discovery');
  fs.mkdirSync(path.join(process.env.MYCC_DISCOVERY_DIR!, 'heartbeat'), { recursive: true });
  fs.mkdirSync(process.env.MYCC_DISCOVERY_DIR!, { recursive: true });
  // Fresh random SID per test (issue #8: a fixed sid shared across suites
  // lets any leak poison the next suite to import it).
  SID = randomUUID();
  specFile = path.join(tempDir, 'spec.json');
});

afterEach(() => {
  delete process.env.MYCC_DISCOVERY_DIR;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  d = null;
  vi.restoreAllMocks();
});

describe('cmdUp: sync never recycles renew:always peers (P1-1 regression)', () => {
  it('sync (allowStop:false) leaves a live+matching renew:always peer running', async () => {
    d = await import('../../scripts/mycc-compose/lib/discovery.js');
    writeSpec('always');
    seedIdentity();
    seedHeartbeat(SID);

    const { rows, exitCode } = await runCmdUpAllowStop(false);

    // Positive control FIRST: the fixture peer IS live + matching.
    expect(d.isPeerRunning({ sessionId: SID, workdir: tempDir })).toBe(true);
    // No stop was attempted, nothing launched.
    expect(stopPeerSpy).not.toHaveBeenCalled();
    expect(launchPeerSpy).not.toHaveBeenCalled();
    // The decision row names the sync-left-running outcome.
    expect(rows.join('')).toMatch(/renew:always \(sync: left running, no stop\)/);
    // Sync is a reconciler tick: success.
    expect(exitCode).toBe(0);
  }, 20_000);

  it('up (allowStop:true) stops and restarts the renew:always peer', async () => {
    d = await import('../../scripts/mycc-compose/lib/discovery.js');
    writeSpec('always');
    seedIdentity();
    seedHeartbeat(SID);

    const { rows, exitCode } = await runCmdUpAllowStop(true);

    // The stop ran on the pinned peer, then the relaunch did.
    expect(stopPeerSpy).toHaveBeenCalledTimes(1);
    expect((stopPeerSpy.mock.calls[0] as unknown[])[0]).toMatchObject({ name: 'always-peer', sessionId: SID });
    expect(launchPeerSpy).toHaveBeenCalledTimes(1);
    // Post-launch liveness resolves: the fake launch registered a beating
    // entry, so no "peers not live" warning and exit 0.
    expect(rows.join('')).toMatch(/renew:always → stop=stopped, start/);
    expect(rows.join('')).not.toMatch(/LAUNCH FAILED/);
    expect(exitCode).toBe(0);
  }, 20_000);

  it('parity guard: renew:onMismatch with a live+matching peer stays untouched under sync AND up', async () => {
    d = await import('../../scripts/mycc-compose/lib/discovery.js');
    writeSpec('onMismatch');
    seedIdentity();
    seedHeartbeat(SID);

    const synced = await runCmdUpAllowStop(false);
    const upped = await runCmdUpAllowStop(true);

    expect(synced.rows.join('')).toMatch(/skip \(live \+ match\)/);
    expect(upped.rows.join('')).toMatch(/skip \(live \+ match\)/);
    expect(stopPeerSpy).not.toHaveBeenCalled();
    expect(launchPeerSpy).not.toHaveBeenCalled();
  }, 30_000);
});