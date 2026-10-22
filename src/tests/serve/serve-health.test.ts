/**
 * serve-health.test.ts - GET /health + GET /config endpoint shape (Step 4 & 5)
 *
 * Live integration test: boots a REAL `mycc --serve` in a detached tmux
 * session, waits for the "Web UI started" banner, then curls the two
 * client-facing endpoints and asserts their JSON contracts:
 *
 *   /health — registered BEFORE viteServer.middlewares so it answers while
 *     Vite is still compiling. Must carry: status, pid, uptimeMs, version,
 *     serve.{port,host,clients,persistent,agentRunning,auto}, provider.
 *   /config — the per-file upload cap + persistent flag the Web UI reads at
 *     load so it renders 重启 vs 退出. Must carry: maxUploadMb, persistent.
 *
 * The `persistent` flag reflects `shouldDaemon()` (the --daemon CLI flag).
 * This test boots WITHOUT --daemon, so `persistent` is `false` — the
 * non-persistent contract (a non-daemon serve keeps the 30 s disconnect
 * self-close and renders 退出, not 重启). The persistent path (persistent
 * === true) is exercised by a daemon boot; the live tmux harness here is
 * kept daemon-less so it also asserts the non-persistent shape end-to-end.
 *
 * This is a live tmux-driven test (per the project's testing preference for
 * serve), NOT a mock-heavy unit test: no config.js / vite stubs. The real
 * Express routes inside ServeHub.start() are exercised over a real HTTP
 * socket. It skips cleanly when tmux or the global `mycc` command are not
 * available (CI without tmux should not fail).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';

const PORT = 3191; // dedicated to this test suite; unlikely to collide
const SESSION = 'serve-health-test';

function sh(cmd: string, timeoutMs = 10000): string {
  return execSync(cmd, { encoding: 'utf-8', timeout: timeoutMs });
}

/**
 * Cross-platform blocking sleep. The original used
 * `powershell -Command "Start-Sleep -Seconds N"`, which only exists on
 * Windows and silently breaks the suite on Linux/macOS (`powershell: not
 * found`). Spawn node with a busy-wait loop instead — node is a hard
 * prerequisite for this repo, so it is always on PATH on every platform.
 */
function sleepSync(seconds: number): void {
  sh(`node -e "var d=Date.now()+${Math.floor(seconds * 1000)};while(Date.now()<d){}"`, 10000);
}

/** The null-redirection token for the current platform. `2>nul` is
 *  Windows-only and on Linux it creates a stray file named `nul` in the CWD
 *  (and does NOT actually suppress stderr). Use `2>/dev/null` on Unix. */
const DEVNULL = process.platform === 'win32' ? '2>nul' : '2>/dev/null';

/** True when a usable tmux SERVER is reachable. `tmux -V` only proves the
 *  binary is on PATH — it does NOT start or contact a server. A machine can
 *  have tmux installed but no server running (e.g. a fresh CI box, or a
 *  headless container without a tmux session ever started), in which case
 *  `tmux kill-session` throws "no server running". `tmux new-session -d`
 *  DOES start a server if none exists, so probe by creating + killing a
 *  throwaway session: if that round-trips, the live-tmux suite can run. */
function hasTmux(): boolean {
  try { sh('tmux -V', 3000); } catch { return false; }      // binary present?
  try {
    sh('tmux new-session -d -s __probe__ 2>/dev/null', 3000);
    sh('tmux kill-session -t __probe__ 2>/dev/null', 3000);
    return true;
  } catch { return false; }
}

/** True when the global `mycc` command resolves (npm link present).
 *  Uses `where`/`which` rather than spawnSync('mycc',…) because on Windows the
 *  global shim is a .cmd/.ps1 that spawnSync without shell:true cannot resolve
 *  even though pwsh finds it. `where`/`which` matches the shell's own lookup. */
function hasMycc(): boolean {
  const lookup = process.platform === 'win32' ? 'where mycc' : 'which mycc';
  try {
    const out = sh(lookup, 5000);
    return out.trim().length > 0;
  } catch { return false; }
}

const tmuxOk = hasTmux();
const myccOk = hasMycc();
const canRun = tmuxOk && myccOk;

/** Fetch JSON from a URL via node's global fetch (vitest runs on node 18+). */
async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/** Start the serve instance in a detached tmux session and wait until the
 *  "Web UI started" banner appears (or timeout). */
function startServe(): void {
  try { sh(`tmux kill-session -t ${SESSION} ${DEVNULL}`, 3000); } catch { /* no server / no session — best-effort cleanup */ }
  sh(`tmux new-session -s ${SESSION} -d -x 120 -y 40`);
  // Send the command WITHOUT Enter, pause, then Enter — the mycc Enter
  // throttle rejects a text+Enter typed back-to-back.
  sh(`tmux send-keys -t ${SESSION} "mycc --serve ${PORT} --skip-healthcheck"`);
  sleepSync(2);
  sh(`tmux send-keys -t ${SESSION} Enter`);
  // Poll the pane for the startup banner.
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

describe.skipIf(!canRun)('ServeHub /health + /config (live tmux)', () => {
  // One shared serve instance for the whole file — booting mycc twice (once
  // per describe block) races the port release and yields ECONNRESET on the
  // second fetch. A single beforeAll/afterAll pair starts the tmux session
  // once and tears it down once, so every assertion below hits the same
  // running server.
  beforeAll(startServe, 60_000);
  afterAll(stopServe, 15_000);

  it('/health returns status ok with pid, uptimeMs, version', async () => {
    const body = await fetchJson(`http://localhost:${PORT}/health`);
    expect(body['status']).toBe('ok');
    expect(typeof body['pid']).toBe('number');
    expect(typeof body['uptimeMs']).toBe('number');
    expect(body['uptimeMs']).toBeGreaterThanOrEqual(0);
    expect(typeof body['version']).toBe('string');
  });

  it('/health serve sub-object carries port, host, clients, persistent, agentRunning, auto', async () => {
    const body = await fetchJson(`http://localhost:${PORT}/health`);
    const serve = body['serve'] as Record<string, unknown>;
    expect(serve['port']).toBe(PORT);
    // No --host → null (localhost-only bind).
    expect(serve['host']).toBeNull();
    expect(typeof serve['clients']).toBe('number');
    // No --daemon → shouldDaemon() === false → non-persistent (this test
    // boots `mycc --serve` without --daemon, the non-persistent contract).
    expect(serve['persistent']).toBe(false);
    expect(serve['agentRunning']).toBe(false);
    expect(serve['auto']).toBe(false);
  });

  it('/health provider field is a string (ollama or deepseek)', async () => {
    const body = await fetchJson(`http://localhost:${PORT}/health`);
    expect(body['provider']).toMatch(/^(ollama|deepseek)$/);
  });

  it('/health answers before Vite middleware (reachable right after start)', async () => {
    // The endpoint is registered BEFORE viteServer.middlewares so a watchdog
    // polling during Vite warm-up gets an answer, not a Vite transform pass.
    // By the time the banner shows, /health is live; reaching it here confirms
    // the route is not shadowed by the Vite middleware layer.
    const body = await fetchJson(`http://localhost:${PORT}/health`);
    expect(body['status']).toBe('ok');
  });

  it('/config returns maxUploadMb and persistent', async () => {
    const body = await fetchJson(`http://localhost:${PORT}/config`);
    expect(typeof body['maxUploadMb']).toBe('number');
    expect(body['maxUploadMb']).toBeGreaterThan(0);
    // No --daemon → shouldDaemon() === false → non-persistent.
    expect(body['persistent']).toBe(false);
  });
});

// When tmux or mycc is missing, emit a single record-keeping test so the
// suite reports WHY it skipped rather than silently passing with 0 tests.
describe.skipIf(canRun)('ServeHub live tmux tests (skipped: tmux/mycc unavailable)', () => {
  it('skipped — tmux or global mycc command not found on PATH', () => {
    // Pure presence guard; the real work is in the skipped blocks above.
    expect(canRun).toBe(false);
  });
});