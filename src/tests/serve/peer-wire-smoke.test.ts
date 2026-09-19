/**
 * peer-wire-smoke.test.ts — Remote peer wire SMOKE test (live tmux boot)
 *
 * Two-instance transport validation over REAL processes:
 *   - instance A: a real `mycc --serve` booted in a detached tmux session
 *     (the acceptor side — the REAL ServeHub /peer/ws upgrade route, the
 *     REAL ParentContext WireHooks, the REAL MailBox.appendMail writer)
 *   - instance B: THIS vitest process acting as the dialing peer via the
 *     REAL wire-client dialer (connectPeer) and its test-harness WireHooks
 *     (the same makeHooks convention as peer-wire.test.ts)
 *
 * This is the transport-only scope per docs/remote-peer-protocol.md §7:
 * the smoke test runs on ONE machine sharing the discovery store, so with
 * --debug-wire (mirrors MYCC_WIRE_ALLOW_LOCAL) it validates the WIRE
 * TRANSPORT through a real boot; the locality boundary itself is
 * unit-tested in peer-wire.test.ts (fake identity.json, sid-keyed not
 * URL-keyed). The LLM loop is deliberately NOT driven (the
 * serve-health.test.ts precedent: no cloud-model dependency in tests).
 * Instead of driving instance A's agent, the dialer→acceptor mail direction
 * is asserted against instance A's on-disk mailbox artifact
 * (.mycc/sessions/{sid}/unread-lead.jsonl), which proves the full G3 hook
 * chain (wire socket → acceptor → WireHooks → MailBox.appendMail) of a
 * REAL boot with zero mocks. The acceptor→dialer direction rides the same
 * socket/frames and is covered bidirectionally by the in-process suite.
 *
 * DisconnectTimer isolation (§7 round-1 addition (a), second direction):
 * while the wire is live, a webui WS client is connected to /ws; the wire
 * is dropped (4001) and /health must still answer with clients:1 — the
 * acceptor's close path must NOT arm the 30s disconnect timer (G1). The
 * FIRST direction (last human leaves with a wire live → the stack still
 * auto-shuts-down) is the 30s-budget contract of a non-daemon boot; this
 * suite deliberately does not burn 30+ seconds asserting it (the timer's
 * own semantics are covered by serve-disconnect-timer.test.ts, and the
 * acceptor's structural isolation — no clients.add, no timer touch — is
 * asserted in peer-wire.test.ts); here the non-persistent /health shape
 * (persistent:false) IS asserted as the boot-side half.
 *
 * Skips cleanly when tmux or the global `mycc` command are unavailable.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { WebSocket } from 'ws';

// ---- Test-process dialer harness (instance B) ------------------------------
// config.js is NOT mocked here: the booted instance reads its own store; the
// dialer in THIS process only needs MYCC_WIRE_TOKEN/MYCC_WIRE_ALLOW_LOCAL env
// (read via isWireDebugLocal in config.js — the --debug-wire CLI flag maps to
// MYCC_WIRE_ALLOW_LOCAL='true'; here the raw env var is set directly since
// this is a test process, not a CLI boot) and a WireHooks harness (the
// peer-wire.test.ts makeHooks convention).
//
// NOTE on MYCC_DIR: it is '.mycc' RELATIVE to the process cwd. Both the
// booted instance and this test run in C:\Proj\mycc, so instance A's session
// directory is resolvable as .mycc/sessions/{sid} — that is exactly how the
// mail-delivery assertion reads the real mailbox artifact on disk.
import { setWireHooks, resetWireRegistry, resetSeenMailIds, sendWireMail, type WireHooks } from '../../peer/wire-registry.js';
import { connectPeer, disconnectPeer, stopWireClient, resetWireClient } from '../../peer/wire-client.js';
import { getSessionDir } from '../../config.js';

const PORT = 3195; // dedicated to this suite; unlikely to collide
const SESSION = 'peer-wire-smoke';
const TOKEN = 'smoke-wire-token';

/** Collected hook calls (instance B's observer). */
interface HookLog {
  todos: Array<{ sid: string; endpoint: string; done: boolean }>;
  mails: Array<{ from: string; title: string; content: string }>;
}

function makeHooks(sid: string, log: HookLog): WireHooks {
  return {
    getSessionId: () => sid,
    getWorkDir: () => process.cwd(),
    getDaemon: () => false,
    getRole: () => undefined,
    getServingEndpoint: () => null,
    recordRemotePeerTodo: (entry) => { log.todos.push({ ...entry }); },
    appendLocalMail: (from, title, content) => { log.mails.push({ from, title, content }); },
    verbose: () => { /* keep the smoke output clean */ },
  };
}

function sh(cmd: string, timeoutMs = 10000): string {
  return execSync(cmd, { encoding: 'utf-8', timeout: timeoutMs });
}

/** Cross-platform blocking sleep. The original used
 *  `powershell -Command "Start-Sleep -Seconds N"` (Windows-only); spawn a
 *  node busy-wait instead so the same command works on Linux/macOS too.
 *  See serve-health.test.ts for the same fix. */
function sleepSync(seconds: number): void {
  sh(`node -e "var d=Date.now()+${Math.floor(seconds * 1000)};while(Date.now()<d){}"`, 10000);
}

/** The null-redirection token for the current platform. `2>nul` is
 *  Windows-only and on Linux creates a stray file named `nul` in the CWD
 *  (and does NOT suppress stderr). Use `2>/dev/null` on Unix. */
const DEVNULL = process.platform === 'win32' ? '2>nul' : '2>/dev/null';

/** True when a usable tmux SERVER is reachable. `tmux -V` only proves the
 *  binary is on PATH — it does NOT start or contact a server. A machine can
 *  have tmux installed but no server running, in which case `tmux
 *  kill-session` throws "no server running". Probe by creating + killing a
 *  throwaway session: `tmux new-session -d` starts a server if none exists,
 *  so if that round-trips the live-tmux suite can run. See
 *  serve-health.test.ts for the same fix. */
function hasTmux(): boolean {
  try { sh('tmux -V', 3000); } catch { return false; }
  try {
    sh(`tmux new-session -d -s __probe__ ${DEVNULL}`, 3000);
    sh(`tmux kill-session -t __probe__ ${DEVNULL}`, 3000);
    return true;
  } catch { return false; }
}

function hasMycc(): boolean {
  const lookup = process.platform === 'win32' ? 'where mycc' : 'which mycc';
  try { return sh(lookup, 5000).trim().length > 0; } catch { return false; }
}

const tmuxOk = hasTmux();
const myccOk = hasMycc();
const canRun = tmuxOk && myccOk;

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/** Start the acceptor instance in a detached tmux session and wait for the
 *  banner. The --wire-token flag (alias for MYCC_WIRE_TOKEN) authorizes
 *  /peer/ws upgrades on the booted acceptor — a token configured on the
 *  acceptor means a missing/mismatched dialer token is rejected with 401
 *  (the optional in-app auth gate; the negative is covered in the
 *  in-process suite). */
function startServe(): void {
  try { sh(`tmux kill-session -t ${SESSION} ${DEVNULL}`, 3000); } catch { /* no server / no session — best-effort cleanup */ }
  sh(`tmux new-session -s ${SESSION} -d -x 120 -y 40`);
  // Enter throttle discipline (mycc-online-hotfix skill): text first, pause, Enter.
  sh(`tmux send-keys -t ${SESSION} "mycc --serve ${PORT} --wire-token ${TOKEN} --debug-wire --skip-healthcheck"`);
  sleepSync(2);
  sh(`tmux send-keys -t ${SESSION} Enter`);
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    sleepSync(2);
    const pane = sh(`tmux capture-pane -t ${SESSION} -p -S -100`);
    if (pane.includes('Web UI started')) return;
    if (/Error:|EADDRINUSE|Cannot find/i.test(pane) && !pane.includes('Web UI started')) {
      throw new Error(`serve failed to start:\n${pane}`);
    }
  }
  throw new Error('serve did not print "Web UI started" within 45s');
}

function stopServe(): void {
  try { sh(`tmux send-keys -t ${SESSION} Escape`, 3000); } catch { /* ignore */ }
  sleepSync(1);
  try { sh(`tmux kill-session -t ${SESSION}`, 3000); } catch { /* already gone */ }
}

/** Read instance A's real unread mailbox (MailBox.appendMail writes
 *  .mycc/sessions/{sid}/unread-lead.jsonl — MYCC_DIR is cwd-relative and
 *  the booted instance shares this repo as its cwd). */
function readRemoteMailbox(sid: string): Array<Record<string, unknown>> {
  const mailbox = path.join(getSessionDir(sid), 'unread-lead.jsonl');
  if (!fs.existsSync(mailbox)) return [];
  return fs.readFileSync(mailbox, 'utf-8').trim().split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Wait until fn() returns truthy (vi.waitFor wrapper for plain sync checks). */
async function waitFor<T>(fn: () => T, timeoutMs = 8000, what = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** A raw webui WS client on /ws (the "human" for the DisconnectTimer
 *  isolation test — same route the browser uses, no LLM involvement). */
function openWebuiClient(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

describe.skipIf(!canRun)('peer wire two-instance smoke (live tmux)', () => {
  // Instance A's session id, discovered from the real /health peer block.
  let remoteSid: string;
  // Instance B (this process) hook log.
  const log: HookLog = { todos: [], mails: [] };
  // The dialer's fixed sid for THIS process.
  const DIALER_SID = 'smoke-dialer-11111111';

  beforeAll(startServe, 60_000);
  afterAll(stopServe, 15_000);

  beforeEach(() => {
    log.todos.length = 0;
    log.mails.length = 0;
    resetWireRegistry();
    resetSeenMailIds();
    resetWireClient();
    process.env.MYCC_WIRE_TOKEN = TOKEN;
    process.env.MYCC_WIRE_ALLOW_LOCAL = '1'; // one-machine smoke scope (§7); routed via isWireDebugLocal()
    setWireHooks(makeHooks(DIALER_SID, log));
  });

  afterEach(() => {
    stopWireClient();
    delete process.env.MYCC_WIRE_TOKEN;
    delete process.env.MYCC_WIRE_ALLOW_LOCAL;
  });

  it('/health exposes the peer block of the real boot (sessionId, daemon)', async () => {
    const body = await fetchJson(`http://localhost:${PORT}/health`);
    const peer = body['peer'] as Record<string, unknown>;
    // The real ParentContext hooks are behind this block (G3): a non-null
    // sessionId proves the booted instance wired its wire hooks at boot.
    expect(typeof peer['sessionId']).toBe('string');
    expect(peer['sessionId']).toBeTruthy();
    remoteSid = peer['sessionId'] as string;
    // Non-daemon boot → daemon:false (the non-persistent contract half of
    // the DisconnectTimer isolation direction 1).
    expect(peer['daemon']).toBe(false);
    const serve = body['serve'] as Record<string, unknown>;
    expect(serve['persistent']).toBe(false);
  }, 20_000);

  it('establishes a wire to the real boot and exchanges announce frames', async () => {
    const health = await fetchJson(`http://localhost:${PORT}/health`);
    remoteSid = (health['peer'] as Record<string, unknown>)['sessionId'] as string;

    const result = await connectPeer(`localhost:${PORT}`);
    expect(result).toContain('Wire established');
    expect(result).toContain(remoteSid);

    // The dialer's registry holds the pair with a LIVE socket, keyed by the
    // real endpoint (localhost:PORT) — the pre-check will use it next.
    expect(result).not.toContain('Error:');

    // Duplicate dial while the first wire is live → pre-check rejection
    // (pair-dedupe layer 1) against the REAL acceptor.
    const dup = await connectPeer(`localhost:${PORT}`);
    expect(dup).toContain('Already connected');

    // Info-symmetry todo fired on establishment (test g, dialer side).
    expect(log.todos.some((t) => t.sid === remoteSid && !t.done)).toBe(true);
  }, 30_000);

  it('delivers wire mail into the real boot mailbox (G3 chain end-to-end)', async () => {
    const health = await fetchJson(`http://localhost:${PORT}/health`);
    remoteSid = (health['peer'] as Record<string, unknown>)['sessionId'] as string;
    await connectPeer(`localhost:${PORT}`);

    const title = `[smoke] wire mail ${Date.now()}`;
    const content = 'two-instance smoke: dialer → real acceptor → MailBox.appendMail';
    const sent = sendWireMail(remoteSid, title, content);
    expect(sent).toBe(true);

    // The mail must land in instance A's REAL on-disk inbox. This exercises
    // the full G3 chain of the booted process: /peer/ws upgrade route →
    // acceptor onMail → seen-id dedupe → hooks.appendLocalMail (real
    // ParentContext wiring) → MailBox.appendMail → unread-lead.jsonl.
    const mails = await waitFor(() => {
      const got = readRemoteMailbox(remoteSid);
      return got.some((m) => m['title'] === title) ? got : null;
    }, 8000, 'wire mail in remote mailbox');
    const hit = mails!.find((m) => m['title'] === title)!;
    expect(hit['content']).toBe(content);
    expect(String(hit['from'])).toContain(DIALER_SID);
  }, 30_000);

  it('peer_disconnect sends 4001, tears down the pair on both ends', async () => {
    const health = await fetchJson(`http://localhost:${PORT}/health`);
    remoteSid = (health['peer'] as Record<string, unknown>)['sessionId'] as string;
    await connectPeer(`localhost:${PORT}`);

    const result = await disconnectPeer(remoteSid);
    expect(result).toContain('redial loop is cancelled'); // bye (4001) is terminal
    expect(result).not.toContain('Error:');

    // A re-connect after 4001 works (terminal for the LOOP, not a ban) —
    // this also exercises the acceptor's 4001 close handling on the real
    // boot: the accepted socket is pruned WITHOUT touching the webui stack.
    const again = await connectPeer(`localhost:${PORT}`);
    expect(again).toContain('Wire established');

    await disconnectPeer(remoteSid); // leave the boot clean for the next test
  }, 30_000);

  it('wire drop does NOT arm the disconnect timer while a human is on the webui (G1, direction 2)', async () => {
    const health = await fetchJson(`http://localhost:${PORT}/health`);
    remoteSid = (health['peer'] as Record<string, unknown>)['sessionId'] as string;
    await connectPeer(`localhost:${PORT}`);

    // The "human": a webui client on /ws. G1: a peer wire must not sustain
    // the stack — conversely the wire's death must not count as the last
    // human leaving (no clients.add on the acceptor path, no timer arm).
    const human = await openWebuiClient();

    // Drop the wire (4001 both directions).
    await disconnectPeer(remoteSid);

    // Give the hub ample time to notice the close and (wrongly) arm a
    // much-shorter-than-30s timer — the budget itself is 30s, so a fast
    // follow-up poll inside that window is the honest assertion: the stack
    // must still be up, the human still counted.
    await new Promise((r) => setTimeout(r, 1500));
    const after = await fetchJson(`http://localhost:${PORT}/health`);
    expect(after['status']).toBe('ok');
    const serve = after['serve'] as Record<string, unknown>;
    expect(serve['clients']).toBe(1);

    human.close();
    // Leave the stack for the afterAll teardown; the disconnect timer may
    // arm now (legitimately — the last human DID leave), but the tmux kill
    // in stopServe() ends the process long before the 30s budget fires.
  }, 30_000);
});

// When tmux or mycc is missing, emit a single record-keeping test so the
// suite reports WHY it skipped rather than silently passing with 0 tests.
describe.skipIf(canRun)('peer wire smoke (skipped: tmux/mycc unavailable)', () => {
  it('skipped — tmux or global mycc command not found on PATH', () => {
    expect(canRun).toBe(false);
  });
});