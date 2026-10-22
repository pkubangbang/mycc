/**
 * mycc-compose-runtime.test.ts - merged up / down / status / restart-race suites.
 *
 * Consolidation of the four root-level mycc-compose suites that drive the
 * command pipeline end to end (cmdUp / cmdDown / cmdStatus) and therefore share
 * the same module-graph discipline:
 *
 *   - mycc-compose-up-pipeline.test.ts  `sync` (cmdUp with allowStop:false) never
 *                                       recycles a live renew:"always" peer.
 *   - mycc-compose-down.test.ts         `down` stops peers BEFORE deleting the
 *                                       channel files and reports honestly.
 *   - mycc-compose-status.test.ts       `status --json` is deterministic and the
 *                                       channel rows are FILENAME-keyed.
 *   - mycc-compose-restart-race.test.ts restart is sequenced (confirm the prior
 *                                       holder is dead before relaunching).
 *
 * Discovery pins DISCOVERY_DIR / HEARTBEAT_DIR at MODULE LOAD, so NOTHING from
 * compose-lib is imported statically here: every suite dynamically imports the
 * graph AFTER its own MYCC_DISCOVERY_DIR override, seeds through that module's
 * own exported constants, and uses a fresh random SID per test. Each source
 * suite is preserved VERBATIM inside its own scoped `describe()` block, so a
 * suite-local beforeEach (temp dir + env override + process.exit stub) can
 * never leak into another suite's tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';

// ==========================================================================
// merged from mycc-compose-up-pipeline.test.ts
// ==========================================================================
describe('cmdUp pipeline: sync vs up' + ' (merged from mycc-compose-up-pipeline.test.ts)', () => {
  type Discovery = typeof import('../../scripts/mycc-compose/lib/discovery.js');

  const ARGS = '--auto --skip-healthcheck';

  let tempDir = '';
  let specFile = '';
  let SID = '';
  /** The spec-facing leaf name, referenced by channels and printed in reports. */
  const PEER_NAME = 'always-peer';
  /** The fully qualified runtime identity carried by `--name`. */
  const PEER_IDENTITY_NAME = 'grp:always-peer';
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
  let stopMod: typeof import('../../scripts/mycc-compose/lib/peers-stop.js');
  let launchPeerSpy: ReturnType<typeof vi.fn>;
  let stopPeerSpy: ReturnType<typeof vi.fn>;
  /**
   * Snapshot of the peer argument as it was AT EACH stopPeer call. cmdUp carries
   * ONE mutable peer object through stop→cull→relaunch, and the post-stop cull
   * deliberately nulls `peer.sessionId` on it (Windows: a SIGTERM'd peer never
   * unregisters, so the stale entry must be culled by the sid we still hold).
   * Asserting on `stopPeerSpy.mock.calls[0][0]` therefore observes the MUTATED
   * object, not the value passed in. These snapshots capture the call-time state.
   */
  let stopPeerArgs: Array<{ name?: string; sessionId?: string | null }>;

  /** Seed identity.json with the entry a real registered peer would have. The
   * durable NAME is what matching resolves on now (the session id is minted per
   * run and is not a spec field) — so the entry must publish it, exactly as
   * IdentityManager.register() does for a `--name`-launched peer. */
  function seedIdentity(): void {
    const map: Record<string, unknown> = {};
    map[SID] = {
      sessionId: SID,
      name: PEER_IDENTITY_NAME,
      pid: process.pid,
      workDir: tempDir,
      args: ARGS,
      startedAt: Date.now(),
    };
    d!.writeIdentityMap(map as never);
  }

  /** Fresh heartbeat at the DISCOVERY-side path (never a re-derived path). */
  function seedHeartbeat(sid: string, when = Date.now()): void {
    const hbFile = path.join(d!.HEARTBEAT_DIR, `${sid}.json`);
    fs.mkdirSync(path.dirname(hbFile), { recursive: true });
    fs.writeFileSync(
      hbFile,
      JSON.stringify({ heartbeats: [when], briefs: [], pid: process.pid }),
    );
  }

  /** A minimal valid spec: one peer with the given renew policy. No `sessionId`
   * — specs never author one any more (identity is `--name`, resolved at
   * runtime from identity.json). */
  function writeSpec(renew: 'always' | 'onMismatch'): void {
    fs.writeFileSync(specFile, JSON.stringify({
      group: 'grp',
      peers: [{ name: PEER_NAME, workdir: tempDir, args: ARGS, renew }],
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
      async (peer: { name?: string; identityName?: string; sessionId?: string | null }) => {
        // The spy registers the fake peer in the identity map exactly as a
        // real launch+register() would, so the post-launch liveness wait
        // resolves on its first poll. The entry publishes the durable NAME —
        // that is what resolvePeerSid scans for — under a fresh sid (the peer
        // mints its own on boot in production; here the fixture sid stands in).
        const sid = peer.sessionId ?? SID;
        peer.sessionId = sid;
        const map = d!.readIdentityMap();
        map[sid] = {
          sessionId: sid,
          name: peer.identityName ?? (peer.name ? 'grp:' + peer.name : PEER_IDENTITY_NAME),
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
    stopMod = await import('../../scripts/mycc-compose/lib/peers-stop.js');
    stopPeerSpy = vi.spyOn(stopMod, 'stopPeerByAddress').mockImplementation(
      (async (address: { cwd: string; group: string; name: string }) => {
        // Snapshot the address as passed (see stopPeerArgs).
        stopPeerArgs.push({ name: address.name, sessionId: SID });
        // Model a REAL successful stop's side effect: the holder process is
        // terminated, so it stops beating and (on POSIX) unregisters. A stubbed
        // 'stopped' that leaves the holder ALIVE would make CONFIRM (inside the
        // primitive) time out — the correct product behavior, but not what this
        // fixture exercises. Delete the holder's identity entry and heartbeat so
        // the name no longer resolves to a live instance, exactly as a killed
        // peer leaves the store.
        const map = d!.readIdentityMap();
        for (const [sid, entry] of Object.entries(map)) {
          const e = entry as { name?: string; sessionId?: string };
          const wireName = `${address.group}:${address.name}`;
          const matches = e.name === wireName || (e.sessionId && e.sessionId === sid);
          if (matches) delete map[sid];
        }
        d!.writeIdentityMap(map as never);
        const hb = path.join(d!.HEARTBEAT_DIR, `${SID}.json`);
        if (fs.existsSync(hb)) { try { fs.rmSync(hb, { force: true }); } catch { /* best-effort */ } }
        return { verdict: 'stopped', sessionId: SID } as never;
      }) as never,
    );
    // Dynamic import AFTER the env override: every module in this graph —
    // cmd-up, the barrel (already spied), peers-state, discovery — now sees
    // the overridden MYCC_DISCOVERY_DIR at load time.
    const mod = await import('../../scripts/mycc-compose/lib/cmd-up.js');
    const cmdUp = (mod as { cmdUp: (file: string, opts: { allowStop: boolean }) => Promise<void> }).cmdUp;
    const rows: string[] = [];
    let exitCode: unknown = undefined;
    stopPeerArgs = [];
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

      // The stop ran on the named peer, then the relaunch did. Assert on the
      // CALL-TIME snapshot: cmdUp carries one mutable peer object and the
      // post-stop cull nulls its sessionId, so the live object in mock.calls
      // would show null even though stopPeer received the real sid.
      expect(stopPeerSpy).toHaveBeenCalledTimes(1);
      expect(stopPeerArgs[0]).toMatchObject({ name: PEER_NAME, sessionId: SID });
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

    it('sync does not launch a duplicate when the heartbeat is stale but the recorded PID may still own the name', async () => {
      d = await import('../../scripts/mycc-compose/lib/discovery.js');
      writeSpec('always');
      seedIdentity();
      seedHeartbeat(SID, Date.now() - 120_000);

      const { rows, exitCode } = await runCmdUpAllowStop(false);

      expect(stopPeerSpy).not.toHaveBeenCalled();
      expect(launchPeerSpy).not.toHaveBeenCalled();
      expect(rows.join('')).toMatch(/stale\/unhealthy \(sync: possible holder remains, no stop\/start\)/);
      expect(exitCode).toBe(1);
    }, 20_000);

    it('S3: never mints or writes a session id back into the spec file', async () => {
      d = await import('../../scripts/mycc-compose/lib/discovery.js');
      writeSpec('always');
      // NO pre-existing live instance: the peer must be launched (not skipped).
      const beforeSpec = fs.readFileSync(specFile, 'utf-8');

      const { rows, exitCode } = await runCmdUpAllowStop(true);

      // The launch happened (a fresh peer with no live entry).
      expect(launchPeerSpy).toHaveBeenCalledTimes(1);
      // The spec file is BYTE-IDENTICAL — Slice 3 removed the mint + write-back,
      // so no `sessionId` is ever injected into the authored spec.
      expect(fs.readFileSync(specFile, 'utf-8')).toBe(beforeSpec);
      const parsed = JSON.parse(fs.readFileSync(specFile, 'utf-8'));
      expect(parsed.peers[0].sessionId).toBeUndefined();
      // No "Minted session ids" row is printed.
      expect(rows.join('')).not.toMatch(/Minted session ids/);
      expect(exitCode).toBe(0);
    }, 20_000);

    it('S3: a launch with no pre-existing entry resolves by NAME (fresh sid, no phantom)', async () => {
      d = await import('../../scripts/mycc-compose/lib/discovery.js');
      writeSpec('always');
      // The launch spy registers a FRESH sid (stand-in for the peer's own boot
      // mint). cmdUp never carried a sid into the launch, so resolution must
      // come purely from the identity entry the spy wrote by NAME.
      const { exitCode } = await runCmdUpAllowStop(true);
      // The launched peer is registered under the durable name; nothing was
      // resolved from a spec/launcher sid, and the liveness wait succeeded.
      const map = d.readIdentityMap();
      const entries = Object.values(map) as Array<{ name?: string }>;
      expect(entries.some((e) => e.name === PEER_IDENTITY_NAME)).toBe(true);
      expect(exitCode).toBe(0);
    }, 20_000);
  });
});

// ==========================================================================
// merged from mycc-compose-down.test.ts
// ==========================================================================
describe('cmdDown teardown' + ' (merged from mycc-compose-down.test.ts)', () => {
  type Discovery = typeof import('../../scripts/mycc-compose/lib/discovery.js');
  type Channels = typeof import('../../scripts/mycc-compose/lib/channels.js');

  const ARGS = '--auto --skip-healthcheck';

  let tempDir = '';
  let specFile = '';
  let SID = '';
  let SID_P2 = '';
  let channelsMod: Channels | null = null;
  let d: Discovery | null = null;

  /** Seed a heartbeat at the DISCOVERY-side path for the given pid. */
  function seedHeartbeat(sid: string, pid: number | undefined, when = Date.now()): void {
    const hbFile = path.join(d!.HEARTBEAT_DIR, `${sid}.json`);
    fs.mkdirSync(path.dirname(hbFile), { recursive: true });
    const data: Record<string, unknown> = { heartbeats: [when], briefs: [] };
    if (pid !== undefined) data.pid = pid;
    fs.writeFileSync(hbFile, JSON.stringify(data));
  }

  /** Seed identity.json with a live-pid entry pinned to THIS temp dir.
   * The durable NAME is what matching resolves on now (identity, not the sid) —
   * the entry must publish it, exactly as register() does for a `--name` peer. */
  function seedIdentity(sid: string, pid: number, name: string): void {
    const map = d!.readIdentityMap();
    map[sid] = {
      sessionId: sid,
      name,
      pid,
      workDir: tempDir,
      args: ARGS,
      startedAt: Date.now(),
    };
    d!.writeIdentityMap(map);
  }

  /**
   * Seed BOTH peers as LIVE (name p1→SID, p2→SID_P2), on a pid that is alive
   * but is NOT a mycc process (this test runner's own pid). This is the state
   * `down` actually operates on — running peers — and it makes production's
   * name-resolution (resolveLivePeer) yield EXACTLY the sids the fixture's
   * channel helpers use, so the expected filename set and production's agree.
   * stopPeer then refuses on the argv-identity gate (no `--name` in this pid's
   * argv), which is what the per-test expectations assert.
   */
  function seedBothLive(): void {
    seedIdentity(SID, process.pid, 'grp:p1');
    seedIdentity(SID_P2, process.pid, 'grp:p2');
    seedHeartbeat(SID, process.pid);
    seedHeartbeat(SID_P2, process.pid);
  }

  /**
   * The channel files the DOWN path can see for the current spec: the name-set is
   * {p1,p2} and the only spec label is 'review', so every planted materialized
   * file (which carries ownerName/peerName p1/p2) is deletable by name (R1).
   * NOTE: this is the NAME-attributed replacement for channelFileNames(); the
   * down path no longer keys on the resolved sids.
   */
  function ownedNames(): string[] {
    return channelFileNames();
  }

  /** Two peers' spec (a channel's ends must differ per spec.ts); both peers
   * share the SAME workdir + args. No `sessionId` — identity is the durable NAME
   * (`--name`), resolved from identity.json at runtime. The channel is p1→p2 so
   * file removal is real; stop assertions target p1. */
  function writeSpec(withChannel: boolean): void {
    const spec: Record<string, unknown> = {
      group: 'grp',
      peers: [
        { name: 'p1', workdir: tempDir, args: ARGS, renew: 'onMismatch' },
        { name: 'p2', workdir: tempDir, args: ARGS, renew: 'onMismatch' },
      ],
      channels: [] as unknown[],
    };
    if (withChannel) {
      spec.channels = [{ from: 'p1', to: 'p2', label: 'review', prompt: 'ping {{to}}' }];
    }
    fs.writeFileSync(specFile, JSON.stringify(spec, null, 2));
  }

  /** Materialize real channel files (via the REAL channels module) under the
   * SAME sids production resolves (seedBothLive), so removeChannels has exactly
   * the files `down` will target and `channels gone` is a real assertion. */
  function materializeChannels(): void {
    channelsMod!.materializeChannels({
      group: 'grp',
      peers: [
        { name: 'p1', identityName: 'grp:p1', sessionId: SID },
        { name: 'p2', identityName: 'grp:p2', sessionId: SID_P2 },
      ],
      channels: [{ from: 'p1', to: 'p2', label: 'review', prompt: 'ping {{to}}' }],
    } as never);
  }

  /** The exact channel filenames the current spec owns (materialized fixtures). */
  function channelFileNames(): string[] {
    return [`${SID}-review.json`, `${SID_P2}-review.json`];
  }

  /** True when every channel file the spec owns is gone from disk. */
  function channelsGone(): boolean {
    return channelFileNames().every((name) => !fs.existsSync(path.join(d!.CHANNELS_DIR, name)));
  }

  /** True when they all exist on disk. */
  function channelsPresent(): boolean {
    return channelFileNames().every((name) => fs.existsSync(path.join(d!.CHANNELS_DIR, name)));
  }

  /** Run cmdDown with out()/exit captured; returns exit code + printed rows. */
  async function runDown(): Promise<{ rows: string[]; exitCode: unknown }> {
    const mod = await import('../../scripts/mycc-compose/lib/cmd-down.js');
    const cmdDown = (mod as { cmdDown: (file: string) => Promise<void> }).cmdDown;
    const rows: string[] = [];
    let exitCode: unknown = undefined;
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      rows.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null | undefined) => {
      exitCode = code;
      throw new Error(`__cmd_down_exit__:${String(code)}`);
    }) as typeof process.exit);
    try {
      // cmdDown is async (the stop primitive awaits confirmation-of-death before
      // the cull); the exit throw is the normal terminal here, so await and catch.
      await cmdDown(specFile);
    } catch (err) {
      if (!(err instanceof Error) || !(err as Error).message.startsWith('__cmd_down_exit__')) throw err;
    } finally {
      vi.restoreAllMocks();
    }
    return { rows, exitCode };
  }

  beforeEach(() => {
    vi.resetModules();
    d = null as unknown as Discovery;
    channelsMod = null;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-down-'));
    process.env.MYCC_DISCOVERY_DIR = path.join(tempDir, 'discovery');
    fs.mkdirSync(path.join(process.env.MYCC_DISCOVERY_DIR!, 'heartbeat'), { recursive: true });
    fs.mkdirSync(process.env.MYCC_DISCOVERY_DIR!, { recursive: true });
    SID = randomUUID();
    SID_P2 = randomUUID();
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
    channelsMod = null;
    vi.restoreAllMocks();
  });

  describe('cmdDown: always-stop + stop-before-delete + honest exit code (P2-b)', () => {
    it('down: removes the channel files and reports each peer stop result', async () => {
      d = await import('../../scripts/mycc-compose/lib/discovery.js');
      channelsMod = await import('../../scripts/mycc-compose/lib/channels.js');
      writeSpec(true);
      materializeChannels();
      // Both peers are live but on a NON-mycc pid (this runner) → stopPeer
      // refuses on the argv-identity gate. That refusal is a non-zero exit, but
      // the channel removal still happens (teardown is decoupled from the stop).
      seedBothLive();

      const preNames = ownedNames();
      expect(preNames.length).toBeGreaterThan(0);
      expect(channelsPresent()).toBe(true);

      const { exitCode, rows } = await runDown();

      expect(exitCode).toBe(1); // both stops refused (their pid is not a --name peer)
      expect(rows.join('')).toMatch(/p1: refused-not-mycc/);
      expect(rows.join('')).toMatch(/p2: refused-not-mycc/);
      expect(channelsGone()).toBe(true);
      expect(rows.join('')).toMatch(/removed \d+ channel file/);
    });

    it('down on a live name-identified peer: stops p1, removes channels', async () => {
      d = await import('../../scripts/mycc-compose/lib/discovery.js');
      channelsMod = await import('../../scripts/mycc-compose/lib/channels.js');
      writeSpec(true);
      materializeChannels();
      // p1: the REAL owner shape — node running a script WITH the peer's durable
      // NAME in argv as `--name grp:p1` (the exact argv isMyccProcess demands).
      const script = path.join(tempDir, 'owner.js');
      fs.writeFileSync(script, 'setTimeout(function(){},600000);');
      const child = spawn(process.execPath, [script, '--name', 'grp:p1'], { stdio: 'ignore' });
      seedIdentity(SID, child.pid as number, 'grp:p1');
      seedHeartbeat(SID, child.pid as number);
      // p2: live but non-mycc (this runner) → its stop refuses, exit is non-zero.
      seedIdentity(SID_P2, process.pid, 'grp:p2');
      seedHeartbeat(SID_P2, process.pid);

      const { exitCode, rows } = await runDown();

      expect(exitCode).toBe(1); // p2 refused
      expect(rows.join('')).toMatch(/p1: stopped/);
      expect(rows.join('')).toMatch(/p2: refused-not-mycc/);
      expect(channelsGone()).toBe(true);
      // The stop happened BEFORE deletion and actually terminated the owner.
      expect(await waitForDead(child.pid as number)).toBe(true);
    }, 15_000);
    it('[M3] a LIVE FOREIGN same-label file SURVIVES down (name attribution spares it)', async () => {
      d = await import('../../scripts/mycc-compose/lib/discovery.js');
      channelsMod = await import('../../scripts/mycc-compose/lib/channels.js');
      writeSpec(true);
      materializeChannels(); // ours: names p1/p2
      seedBothLive();
      // A FOREIGN peer's file with the SAME label 'review' but names outside the
      // spec's name-set → kept (never deletion evidence).
      const FOREIGN_SID = randomUUID();
      const foreign = path.join(d!.CHANNELS_DIR, `${FOREIGN_SID}-review.json`);
      fs.mkdirSync(path.dirname(foreign), { recursive: true });
      fs.writeFileSync(foreign, JSON.stringify({
        channelId: 'review', ownerSessionId: FOREIGN_SID, peerSessionId: SID,
        ownerName: 'grp:other', peerName: 'grp:elsewhere',
      }));

      await runDown();

      expect(channelsGone()).toBe(true);          // ours removed
      expect(fs.existsSync(foreign)).toBe(true);  // foreign survives
    }, 15_000);

    it('runs the stop attempt BEFORE deleting channel files (ordering guard)', async () => {
      // Order proof by observation: cmdDown calls stopPeer() FIRST. With a
      // REFUSING owner (no --name in argv), stopPeer performs a full
      // readProcessCommandLine round-trip before refusing, so the channel
      // deletion — which only happens after the stop loop — is measurable
      // AFTER that refusal. We assert the printed LOG order instead: the
      // per-peer stop result line must precede the "removed N channel file(s)"
      // line (out() writes in command order).
      d = await import('../../scripts/mycc-compose/lib/discovery.js');
      channelsMod = await import('../../scripts/mycc-compose/lib/channels.js');
      writeSpec(true);
      materializeChannels();
      seedBothLive();

      const { rows } = await runDown();
      const text = rows.join('');
      const stopIdx = text.indexOf('refused-not-mycc');
      const delIdx = text.indexOf('removed');
      expect(stopIdx).toBeGreaterThan(-1);
      expect(delIdx).toBeGreaterThan(-1);
      expect(stopIdx).toBeLessThan(delIdx); // stop printed/published FIRST
    }, 15_000);

    it('down with an identity-unverifiable pid: NON-ZERO exit, explicit refusal line, peer survives, channels still removed', async () => {
      d = await import('../../scripts/mycc-compose/lib/discovery.js');
      channelsMod = await import('../../scripts/mycc-compose/lib/channels.js');
      writeSpec(true);
      materializeChannels();
      seedBothLive();

      try {
        const { exitCode, rows } = await runDown();

        expect(exitCode).toBe(1);
        expect(rows.join('')).toMatch(/p1: refused-not-mycc/);
        // The refusal is legible to a human scanning the log for what failed.
        expect(rows.join('')).toMatch(/stop refused for 2 peer/);
        // No process was killed (refuse-not-kill, P1-4): this runner is alive.
        let stillAlive = true;
        try { process.kill(process.pid, 0); } catch { stillAlive = false; }
        expect(stillAlive).toBe(true);
        // Channel deletion still happens (the requested-stop FAILURE does not
        // undo the teardown of the spec's own files).
        expect(channelsGone()).toBe(true);
      } finally {
        // nothing to clean up — we never spawned a throwaway process here
      }
    }, 15_000);
  });

  /** Poll until the pid is dead or the deadline passes. */
  async function waitForDead(pid: number, timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        return true;
      }
    }
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }

  // ---------------------------------------------------------------------------
  // FIX C — `down` culls the identity entries of PROVABLY stopped peers.
  // ---------------------------------------------------------------------------

  /**
   * A pid that is guaranteed DEAD: spawn a trivial node process, wait for it to
   * exit, and return its pid. On Windows a recycled pid is possible in theory
   * but vanishingly unlikely across the few ms this test runs; the cull only
   * needs *this* pid to probe as dead.
   */
  async function deadPid(): Promise<number> {
    const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    const pid = child.pid as number;
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));
    await waitForDead(pid);
    return pid;
  }

  describe('cmdDown: stale heartbeat is not a reason to leave a named peer alive', () => {
    it('finds and terminates a peer by durable name even after its heartbeat expires', async () => {
      d = await import('../../scripts/mycc-compose/lib/discovery.js');
      writeSpec(false);

      const script = path.join(tempDir, 'owner.js');
      fs.writeFileSync(script, 'setTimeout(function(){},600000);');
      const child = spawn(process.execPath, [script, '--name', 'grp:p1'], { stdio: 'ignore' });
      seedIdentity(SID, child.pid as number, 'grp:p1');
      seedHeartbeat(SID, child.pid as number, Date.now() - 120_000);

      try {
        const { rows, exitCode } = await runDown();
        expect(rows.join('')).toMatch(/p1: stopped/);
        expect(await waitForDead(child.pid as number)).toBe(true);
        expect(exitCode).toBe(0);
        expect(d!.readIdentityMap()[SID]).toBeUndefined();
      } finally {
        child.kill();
      }
    }, 15_000);
  });

  describe('cmdDown FIX C: cull provably-stopped peers from identity.json', () => {
    it('(1) stopped peer (spec-resolved, then killed) → its identity entry is REMOVED, culled line printed', async () => {
      d = await import('../../scripts/mycc-compose/lib/discovery.js');
      channelsMod = await import('../../scripts/mycc-compose/lib/channels.js');
      writeSpec(true);
      materializeChannels();
      // p1: the REAL Stage-7 shape — a LIVE, name-identified peer process that
      // `down` actually SIGTERMs. Its entry records that live pid; after the
      // stop, the pid is provably dead and the entry is culled.
      const script = path.join(tempDir, 'owner.js');
      fs.writeFileSync(script, 'setTimeout(function(){},600000);');
      const child = spawn(process.execPath, [script, '--name', 'grp:p1'], { stdio: 'ignore' });
      seedIdentity(SID, child.pid as number, 'grp:p1');
      seedHeartbeat(SID, child.pid as number);
      // p2: live-but-non-mycc (this runner) → its stop refuses, entry kept.
      seedIdentity(SID_P2, process.pid, 'grp:p2');
      seedHeartbeat(SID_P2, process.pid);

      const { rows } = await runDown();

      expect(rows.join('')).toMatch(/p1: stopped/);
      const map = d!.readIdentityMap();
      expect(map[SID]).toBeUndefined();       // culled (pid proven dead post-stop)
      // Kept AND still the same registration: pid alive + death unproven. A
      // bare toBeDefined() would accept a half-written/replaced entry.
      expect(map[SID_P2]).toMatchObject({ sessionId: SID_P2, name: 'grp:p2', pid: process.pid });
      expect(rows.join('')).toMatch(/culled 1 stale identity entr/);
    }, 15_000);

    it('(2) refused stop (live-but-non-mycc pid) → entry KEPT (death unproven)', async () => {
      d = await import('../../scripts/mycc-compose/lib/discovery.js');
      channelsMod = await import('../../scripts/mycc-compose/lib/channels.js');
      writeSpec(true);
      materializeChannels();
      seedBothLive(); // both pids alive (this runner) → both stops refuse

      const { rows } = await runDown();

      const map = d!.readIdentityMap();
      // Refusal must be non-destructive: both registrations survive byte-for-byte
      // in the fields that identity resolution keys on (name + pid).
      expect(map[SID]).toMatchObject({ sessionId: SID, name: 'grp:p1', pid: process.pid });
      expect(map[SID_P2]).toMatchObject({ sessionId: SID_P2, name: 'grp:p2', pid: process.pid });
      expect(rows.join('')).toMatch(/p1: refused-not-mycc/);
      expect(rows.join('')).toMatch(/culled 0 stale identity entr/);
    }, 15_000);

    it('(3) live pid (unproven death) → entry KEPT, even with a fresh heartbeat', async () => {
      d = await import('../../scripts/mycc-compose/lib/discovery.js');
      channelsMod = await import('../../scripts/mycc-compose/lib/channels.js');
      writeSpec(true);
      materializeChannels();
      // A fresh heartbeat + ALIVE pid: liveness is proven, must never be culled.
      seedIdentity(SID, process.pid, 'grp:p1');
      seedHeartbeat(SID, process.pid);
      seedIdentity(SID_P2, process.pid, 'grp:p2');
      seedHeartbeat(SID_P2, process.pid);

      await runDown();

      const map = d!.readIdentityMap();
      // A proven-live peer's registration is never rewritten or dropped.
      expect(map[SID]).toMatchObject({ sessionId: SID, name: 'grp:p1', pid: process.pid });
      expect(map[SID_P2]).toMatchObject({ sessionId: SID_P2, name: 'grp:p2', pid: process.pid });
    }, 15_000);

    it('(4) no identity entry for a spec peer → no-op (culled 0, no throw)', async () => {
      d = await import('../../scripts/mycc-compose/lib/discovery.js');
      channelsMod = await import('../../scripts/mycc-compose/lib/channels.js');
      writeSpec(true);
      materializeChannels();
      // No identity/heartbeat seeded for either peer: nothing to stop, nothing
      // to cull. down must not throw.
      const { rows } = await runDown();

      expect(rows.join('')).toMatch(/culled 0 stale identity entr/);
      expect(d!.readIdentityMap()).toEqual({});
    }, 15_000);

    it('(5) merge-on-read: a concurrent (unrelated) register is PRESERVED across the cull', async () => {
      d = await import('../../scripts/mycc-compose/lib/discovery.js');
      const stateMod = await import('../../scripts/mycc-compose/lib/peers-state.js');
      // Dead-twin candidate to cull.
      const deadP1 = await deadPid();
      seedIdentity(SID, deadP1, 'grp:p1');
      seedHeartbeat(SID, deadP1);
      // A CONCURRENT foreign entry (a different live instance's registration).
      const FOREIGN_SID = randomUUID();
      seedIdentity(FOREIGN_SID, process.pid, 'grp:foreign');
      seedHeartbeat(FOREIGN_SID, process.pid);

      const culled = stateMod.cullStoppedPeers([
        { name: 'p1', identityName: 'grp:p1', sessionId: SID } as never,
      ]);

      expect(culled).toBe(1);
      const map = d!.readIdentityMap();
      expect(map[SID]).toBeUndefined();              // culled
      // The concurrent registration survives with ITS OWN fields — not merely
      // as some truthy value under that key.
      expect(map[FOREIGN_SID]).toMatchObject({
        sessionId: FOREIGN_SID,
        name: 'grp:foreign',
        pid: process.pid,
      });
    }, 15_000);

    it('(6) a cull candidate whose pid was RECYCLED onto a live process is NOT deleted', async () => {
      d = await import('../../scripts/mycc-compose/lib/discovery.js');
      const stateMod = await import('../../scripts/mycc-compose/lib/peers-state.js');
      // Entry records OUR live pid (as if the pid was recycled onto us): the
      // delete-time re-check must see it alive and keep the entry.
      seedIdentity(SID, process.pid, 'grp:p1');
      seedHeartbeat(SID, process.pid);

      const culled = stateMod.cullStoppedPeers([
        { name: 'p1', identityName: 'grp:p1', sessionId: SID } as never,
      ]);

      expect(culled).toBe(0);
      expect(d!.readIdentityMap()[SID]).toMatchObject({
        sessionId: SID,
        name: 'grp:p1',
        pid: process.pid,
      });
    }, 15_000);
  });
});

// ==========================================================================
// merged from mycc-compose-status.test.ts
// ==========================================================================
describe('cmdStatus --json' + ' (merged from mycc-compose-status.test.ts)', () => {
  const SID_A = 'aaaaaaaa-1111-4111-8111-111111111111';
  const SID_B = 'bbbbbbbb-2222-4222-8222-222222222222';

  /** Absolute on THIS host: validateSpec uses Node's platform-native
   *  path.isAbsolute(), so a hardcoded `C:/Proj/mycc` is rejected on POSIX. */
  const FIXTURE_WORKDIR = process.platform === 'win32' ? 'C:/Proj/mycc' : '/proj/mycc';

  let tmp = '';
  let specFile = '';
  let discoveryDir = '';

  async function loadCmdStatus() {
    vi.resetModules();
    return import('../../scripts/mycc-compose/lib/cmd-status.js');
  }

  function captureStdout(): { text: () => string; restore: () => void } {
    let buf = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      buf += String(chunk);
      return true;
    });
    return { text: () => buf, restore: () => spy.mockRestore() };
  }

  /** Write the spec with a p1→p2 channel (two peers so its ends differ). */
  function writeSpec(): void {
    fs.writeFileSync(
      specFile,
      JSON.stringify({
        group: 'g',
        peers: [
          { name: 'p1', workdir: FIXTURE_WORKDIR, args: '--auto' },
          { name: 'p2', workdir: FIXTURE_WORKDIR, args: '--auto' },
        ],
        channels: [{ from: 'p1', to: 'p2', label: 'review', prompt: 'ping {{to}}' }],
      }),
    );
  }

  /** Plant a channel file under the discovery channels dir. */
  function plantChannel(sid: string, label: string, data: Record<string, unknown>): void {
    const dir = path.join(discoveryDir, 'channels');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sid}-${label}.json`), JSON.stringify(data));
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-compose-status-'));
    discoveryDir = path.join(tmp, 'discovery');
    process.env.MYCC_DISCOVERY_DIR = discoveryDir;
    fs.mkdirSync(discoveryDir, { recursive: true });
    specFile = path.join(tmp, 'spec.json');
    writeSpec();
  });

  afterEach(() => {
    delete process.env.MYCC_DISCOVERY_DIR;
    vi.restoreAllMocks();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  /** Run `cmdStatus(specFile, true)` capturing the JSON text. */
  async function runJson(): Promise<{ text: string; parsed: any }> {
    const mod = await loadCmdStatus();
    const sentinel = new Error('__exit__');
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw sentinel;
    });
    const cap = captureStdout();
    try {
      mod.cmdStatus(specFile, true);
    } catch (e) {
      if (e !== sentinel) throw e;
    } finally {
      cap.restore();
    }
    const text = cap.text();
    return { text, parsed: JSON.parse(text) };
  }

  describe('cmdStatus --json: deterministic', () => {
    it('produces byte-identical JSON on two consecutive runs (no timestamp)', async () => {
      const first = await runJson();
      // Ensure the wall clock advances so any timestamp would differ.
      await new Promise((r) => setTimeout(r, 5));
      const second = await runJson();

      expect(first.text).toBe(second.text);
      expect(first.parsed).not.toHaveProperty('generatedAt');
      expect(first.parsed.group).toBe('g');
    });
  });

  describe('cmdStatus --json: channel presence, keyed on the FILENAME (AC-1 / AC-5)', () => {
    it("'present': both endpoint files exist under the resolved sids", async () => {
      // Presence is keyed on NAME → SID → FILENAME, so the peers must RESOLVE:
      // seed live identity entries (fresh heartbeat + alive pid) for g:p1/g:p2.
      plantChannel(SID_A, 'review', {
        channelId: 'review', ownerSessionId: SID_A, peerSessionId: SID_B,
        ownerName: 'g:p1', peerName: 'g:p2',
      });
      plantChannel(SID_B, 'review', {
        channelId: 'review', ownerSessionId: SID_B, peerSessionId: SID_A,
        ownerName: 'g:p2', peerName: 'g:p1',
      });
      seedNamedPeer('g:p1', SID_A);
      seedNamedPeer('g:p2', SID_B);
      const { parsed } = await runJson();
      expect(parsed.channels).toEqual([
        { label: 'review', bothFilesPresent: true, attribution: 'present' },
      ]);
    });

    it("content names are IGNORED: a foreign-sid file with our names is not 'present'", async () => {
      // The old by-name rule reported present from a sibling topology's file
      // (persistent names coincide across specs). Ownership is the FILENAME only.
      plantChannel(SID_A, 'review', {
        channelId: 'review', ownerSessionId: SID_A, peerSessionId: SID_B,
        ownerName: 'g:p1', peerName: 'g:p2',
      });
      const { parsed } = await runJson();
      expect(parsed.channels).toEqual([
        { label: 'review', bothFilesPresent: false, attribution: 'absent' },
      ]);
    });

    it("'present' for pre-v3 files with NO ownership names (filename is enough)", async () => {
      // For the sid fallback the spec peers must resolve to SID_A / SID_B. No live
      // identity exists in the empty store, so seed identity entries that the
      // status resolution adopts by name.
      plantChannel(SID_A, 'review', {
        channelId: 'review', ownerSessionId: SID_A, peerSessionId: SID_B,
      });
      plantChannel(SID_B, 'review', {
        channelId: 'review', ownerSessionId: SID_B, peerSessionId: SID_A,
      });
      seedNamedPeer('g:p1', SID_A);
      seedNamedPeer('g:p2', SID_B);
      const { parsed } = await runJson();
      expect(parsed.channels).toEqual([
        { label: 'review', bothFilesPresent: true, attribution: 'present' },
      ]);
    });

    it("'absent': neither file present", async () => {
      const { parsed } = await runJson();
      expect(parsed.channels).toEqual([
        { label: 'review', bothFilesPresent: false, attribution: 'absent' },
      ]);
    });
  });

  /** Seed identity.json + a fresh heartbeat so `p1`/`p2` resolve to the given
   * sids. resolveLivePeer requires a RUNNING entry (fresh heartbeat AND an alive
   * recorded pid) matching the peer's name+workdir, so both files are needed for
   * the legacy sid fallback to locate the channel files. */
  function seedNamedPeer(name: string, sid: string): void {
    const identityFile = path.join(discoveryDir, 'identity.json');
    const map = fs.existsSync(identityFile)
      ? (JSON.parse(fs.readFileSync(identityFile, 'utf-8')) as Record<string, unknown>)
      : {};
    map[sid] = {
      sessionId: sid,
      name,
      pid: process.pid,
      workDir: FIXTURE_WORKDIR,
      args: '--auto',
      startedAt: Date.now(),
    };
    fs.writeFileSync(identityFile, JSON.stringify(map, null, 2));
    const hbDir = path.join(discoveryDir, 'heartbeat');
    fs.mkdirSync(hbDir, { recursive: true });
    fs.writeFileSync(
      path.join(hbDir, `${sid}.json`),
      JSON.stringify({ heartbeats: [Date.now()], briefs: [], pid: process.pid }),
    );
  }
});

// ==========================================================================
// merged from mycc-compose-restart-race.test.ts
// ==========================================================================
describe('restart sequencing' + ' (merged from mycc-compose-restart-race.test.ts)', () => {
  type Discovery = typeof import('../../scripts/mycc-compose/lib/discovery.js');

  const ARGS = '--auto --skip-healthcheck';
  const PEER_NAME = 'restart-peer';
  const PEER_IDENTITY_NAME = 'grp:restart-peer';

  let tempDir = '';
  let specFile = '';
  let SID = '';
  let d: Discovery | null = null;
  let peersMod: typeof import('../../scripts/mycc-compose/lib/peers.js');
  let stopMod: typeof import('../../scripts/mycc-compose/lib/peers-stop.js');
  let launchPeerSpy: ReturnType<typeof vi.fn>;
  let stopPeerSpy: ReturnType<typeof vi.fn>;

  function seedIdentity(): void {
    const map: Record<string, unknown> = {};
    map[SID] = {
      sessionId: SID,
      name: PEER_IDENTITY_NAME,
      pid: process.pid,
      workDir: tempDir,
      args: ARGS,
      startedAt: Date.now(),
    };
    d!.writeIdentityMap(map as never);
  }

  function seedHeartbeat(sid: string, pid: number = process.pid): void {
    const hbFile = path.join(d!.HEARTBEAT_DIR, `${sid}.json`);
    fs.mkdirSync(path.dirname(hbFile), { recursive: true });
    fs.writeFileSync(hbFile, JSON.stringify({ heartbeats: [Date.now()], briefs: [], pid }));
  }

  function writeSpec(renew: 'always' | 'onMismatch'): void {
    fs.writeFileSync(specFile, JSON.stringify({
      group: 'grp',
      peers: [{ name: PEER_NAME, workdir: tempDir, args: ARGS, renew }],
      channels: [],
    }, null, 2));
  }

  /**
   * Run cmdUp with launchPeer (peers barrel) + stopPeerByAddress (peers-stop)
   * spied. `stopVerdict` is the StopVerdict the stop primitive spy returns
   * ('stopped', 'refused-not-mycc', 'still-up', ...). CONFIRM (wait-for-death) is
   * now INSIDE the primitive, so a holder that never releases is modeled as the
   * primitive returning 'still-up' — there is no separate waitForPeerGone seam.
   */
  async function runCmdUp(opts: {
    allowStop: boolean;
    stopVerdict?: string;
  }): Promise<{ rows: string[]; exitCode: unknown }> {
    peersMod = await import('../../scripts/mycc-compose/lib/peers.js');
    launchPeerSpy = vi.spyOn(peersMod, 'launchPeer').mockImplementation(
      async (peer: { name?: string; identityName?: string; sessionId?: string | null }) => {
        const sid = randomUUID();
        peer.sessionId = sid;
        const map = d!.readIdentityMap();
        map[sid] = {
          sessionId: sid,
          name: peer.identityName ?? (peer.name ? 'grp:' + peer.name : PEER_IDENTITY_NAME),
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
    stopMod = await import('../../scripts/mycc-compose/lib/peers-stop.js');
    stopPeerSpy = vi.spyOn(stopMod, 'stopPeerByAddress').mockImplementation(
      (async () => ({ verdict: (opts.stopVerdict ?? 'stopped') as never, sessionId: SID })) as never,
    );
    const mod = await import('../../scripts/mycc-compose/lib/cmd-up.js');
    const cmdUp = (mod as { cmdUp: (file: string, o: { allowStop: boolean }) => Promise<void> }).cmdUp;
    const rows: string[] = [];
    let exitCode: unknown = undefined;
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      rows.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      rows.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null | undefined) => {
      exitCode = code;
      throw new Error(`__cmd_up_exit__:${String(code)}`);
    }) as typeof process.exit);
    try {
      await cmdUp(specFile, { allowStop: opts.allowStop });
    } catch (err) {
      if (!(err instanceof Error) || !(err as Error).message.startsWith('__cmd_up_exit__')) throw err;
    } finally {
      vi.restoreAllMocks();
    }
    return { rows, exitCode };
  }

  beforeEach(() => {
    vi.resetModules();
    d = null as unknown as Discovery;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-restart-'));
    process.env.MYCC_DISCOVERY_DIR = path.join(tempDir, 'discovery');
    fs.mkdirSync(path.join(process.env.MYCC_DISCOVERY_DIR!, 'heartbeat'), { recursive: true });
    fs.mkdirSync(process.env.MYCC_DISCOVERY_DIR!, { recursive: true });
    SID = randomUUID();
    specFile = path.join(tempDir, 'spec.json');
  });

  afterEach(() => {
    delete process.env.MYCC_DISCOVERY_DIR;
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    d = null;
    vi.restoreAllMocks();
  });

  describe('cmdUp: sequenced restart — wait for the prior holder before relaunch (P2 #1)', () => {
    it('stop=stopped + holder released → the replacement IS launched (happy path)', async () => {
      d = await import('../../scripts/mycc-compose/lib/discovery.js');
      writeSpec('always');
      seedIdentity();
      seedHeartbeat(SID);

      const { rows, exitCode } = await runCmdUp({ allowStop: true, stopVerdict: 'stopped' });

      expect(stopPeerSpy).toHaveBeenCalledTimes(1);
      expect(launchPeerSpy).toHaveBeenCalledTimes(1);
      expect(rows.join('')).toMatch(/renew:always → stop=stopped, start/);
      expect(exitCode).toBe(0);
    }, 20_000);

    it('stop REFUSED → NO launch is queued, restart aborted, non-zero exit', async () => {
      d = await import('../../scripts/mycc-compose/lib/discovery.js');
      writeSpec('always');
      seedIdentity();
      seedHeartbeat(SID);

      const { rows, exitCode } = await runCmdUp({ allowStop: true, stopVerdict: 'refused-not-mycc' });

      // The successful-launch spy must NOT have fired: a refusal cannot be
      // papered over by a launch the name guard would reject.
      expect(stopPeerSpy).toHaveBeenCalledTimes(1);
      expect(launchPeerSpy).not.toHaveBeenCalled();
      expect(rows.join('')).toMatch(/restart ABORTED \(refused\)/);
      expect(rows.join('')).toMatch(/restart aborted for 1 peer/);
      expect(exitCode).toBe(1);
    }, 20_000);

    it('still-up (holder never confirmed dead) → NO launch is queued, restart aborted, non-zero exit', async () => {
      d = await import('../../scripts/mycc-compose/lib/discovery.js');
      writeSpec('always');
      seedIdentity();
      seedHeartbeat(SID);

      // The primitive CONFIRM window expired with the process still alive: the
      // peer could NOT be confirmed down, so no replacement may be queued.
      const { rows, exitCode } = await runCmdUp({ allowStop: true, stopVerdict: 'still-up' });

      expect(launchPeerSpy).not.toHaveBeenCalled();
      expect(rows.join('')).toMatch(/restart ABORTED \(refused\)/);
      expect(rows.join('')).toMatch(/restart aborted for 1 peer/);
      expect(exitCode).toBe(1);
    }, 20_000);

    it('mismatch restart uses the SAME sequencing (stop=stopped + released → launch)', async () => {
      d = await import('../../scripts/mycc-compose/lib/discovery.js');
      // A live peer whose args DIFFER from the spec → treated as a mismatch.
      writeSpec('onMismatch');
      const map: Record<string, unknown> = {};
      map[SID] = {
        sessionId: SID,
        name: PEER_IDENTITY_NAME,
        pid: process.pid,
        workDir: tempDir,
        args: '--auto --skip-healthcheck --ollama-model glm-5:cloud', // differs from ARGS
        startedAt: Date.now(),
      };
      d.writeIdentityMap(map as never);
      seedHeartbeat(SID);

      const { rows, exitCode } = await runCmdUp({ allowStop: true, stopVerdict: 'stopped' });

      expect(rows.join('')).toMatch(/mismatch → stop=stopped, start/);
      expect(launchPeerSpy).toHaveBeenCalledTimes(1);
      expect(exitCode).toBe(0);
    }, 20_000);
  });

  describe('stopPeerByAddress CONFIRM: the bounded death-wait (real, short timeout)', () => {
    it('returns the death verdict once a recorded pid is provably dead (already-stopped)', async () => {
      d = await import('../../scripts/mycc-compose/lib/discovery.js');
      const stop = await import('../../scripts/mycc-compose/lib/peers-stop.js');
      // Seed a holder whose pid is PROVABLY DEAD and whose heartbeat is fresh →
      // the address resolves, the recorded pid is dead → already-stopped.
      const deadPid = await (async () => {
        const { spawn } = await import('child_process');
        const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
        const pid = child.pid as number;
        await new Promise<void>((r) => child.on('exit', () => r()));
        return pid;
      })();
      const map: Record<string, unknown> = {};
      map[SID] = { sessionId: SID, name: PEER_IDENTITY_NAME, pid: deadPid, workDir: tempDir, args: ARGS, startedAt: Date.now() };
      d.writeIdentityMap(map as never);
      seedHeartbeat(SID, deadPid); // fresh heartbeat but DEAD pid

      const result = await stop.stopPeerByAddress(
        { cwd: tempDir, group: 'grp', name: PEER_NAME },
        { confirmTimeoutMs: 500, pollMs: 50 },
      );
      expect(result.verdict).toBe('already-stopped');
      expect(result.sessionId).toBe(SID);
    }, 10_000);

    it('still-up: a live non-mycc holder refuses (never signaled), so the verdict is a refusal', async () => {
      d = await import('../../scripts/mycc-compose/lib/discovery.js');
      const stop = await import('../../scripts/mycc-compose/lib/peers-stop.js');
      // A LIVE holder (this runner's pid, alive) whose argv does NOT claim the
      // peer's durable name → the primitive refuses on the argv-identity gate
      // rather than signal an unrelated process. It never reaches CONFIRM.
      seedIdentity();
      seedHeartbeat(SID, process.pid);

      const result = await stop.stopPeerByAddress(
        { cwd: tempDir, group: 'grp', name: PEER_NAME },
        { confirmTimeoutMs: 300, pollMs: 50 },
      );
      expect(result.verdict).toBe('refused-not-mycc');
      expect(result.sessionId).toBe(SID);
      // Refuse-not-kill: this runner is still alive.
      let alive = true;
      try { process.kill(process.pid, 0); } catch { alive = false; }
      expect(alive).toBe(true);
    }, 10_000);
  });
});
