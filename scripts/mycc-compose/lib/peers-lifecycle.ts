import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, execFileSync, type SpawnOptions, type ChildProcess } from 'child_process';

import { formatLaunchArgsForSpawn } from '../../../src/utils/arg-canonical.js';
import {
  isPidAlive,
  isSessionHolderDead,
  heartbeatPid,
  readIdentityMap,
  resolveLivePeer,
  resolvePeerForStop,
} from './discovery.js';
import {
  LAUNCH_TIMEOUT_MS,
  LAUNCH_POLL_MS,
  isLauncherFlag,
} from './peers-types.js';
import type { Peer } from './peers-types.js';
import { openTerminal } from '../../../src/utils/open-terminal.js';

// Peer launch/stop lifecycle for mycc-compose. Launch mechanics (why
// -EncodedCommand, why npm shims are parsed into real argv, why spawns are
// detached) live in docs/peers/peer-launch-windows.md — code states intent.

const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Build the shell command string a peer terminal must run, from an ABSOLUTE
 * launcher path. The terminal's own shell does not share this process's
 * PATH, so the launcher must be PATH-independent, and the workdir is created
 * before the cd — a missing workdir used to kill the launch here.
 * Windows wraps everything in one EncodedCommand; POSIX stays a plain line.
 */
export function buildPeerShellCommand(command: string, args: string[], cwd: string): string {
  if (process.platform === 'win32') return windowsTerminalCommand(command, args, cwd);
  const invocation = [command, ...args].map(shQuote).join(' ');
  return `mkdir -p ${shQuote(cwd)} && cd ${shQuote(cwd)} && ${invocation}`;
}

/** Windows branch: a PowerShell script — create workdir, cd, invoke — passed
 * as BASE64 UTF-16LE `-EncodedCommand` so no terminal layer can mangle it. */
function windowsTerminalCommand(command: string, args: string[], cwd: string): string {
  // A resolved `.cmd`/`.bat` shim cannot be exec'd with `shell:false` (libuv
  // EINVAL), so the terminal runs it as `cmd /c '<shim>' <args…>` — a real
  // console is wanted here, so the cmd interpreter may stay.
  const invocation = /\.(cmd|bat)$/i.test(command)
    ? `& cmd /c ${[command, ...args].map(psQuote).join(' ')}`
    : `& ${[command, ...args].map(psQuote).join(' ')}`;
  const script =
    `if (-not (Test-Path -LiteralPath ${psQuote(cwd)})) { New-Item -ItemType Directory -LiteralPath ${psQuote(cwd)} -Force | Out-Null }\n` +
    `Set-Location -LiteralPath ${psQuote(cwd)}\n` +
    invocation;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return `powershell -NoExit -EncodedCommand ${encoded}`;
}

export function peerArgv(peer: Peer): string[] {
  const parsed = stripLauncherFlags(peer.parsedArgs);
  const rendered = formatLaunchArgsForSpawn(parsed);
  if (rendered === '(none)') return [];
  const argv: string[] = [];
  for (const group of rendered.split(/\s+(?=--)/)) {
    const sp = group.indexOf(' ');
    if (sp === -1) argv.push(group);
    else {
      argv.push(group.slice(0, sp));
      argv.push(group.slice(sp + 1));
    }
  }
  return argv;
}

function stripLauncherFlags(parsed: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!parsed || typeof parsed !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (isLauncherFlag(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * True when the OS process `pid` is one of OUR launched peers, identified by
 * the durable peer NAME it was spawned with.
 *
 * Identity is an EXACT claim: the peer's `<group>:<peer>` name must appear in
 * the process's OWN argv as `--name <name>` (or `--name=<name>`), because
 * `launchPeer` spawns every peer with exactly that pair. A bare `/mycc/i`
 * substring OR-match cannot establish identity — any process that merely
 * mentions mycc (an editor on the repo, a script named `mycc-*.js`) would pass
 * it and become killable by `stopPeer`.
 *
 * The name replaced the old pinned `--session-id <sid>` match: the launcher no
 * longer hands the peer a fixed sid (the peer mints its own fresh one), so a
 * name — not a per-run id — is what is stable across relaunches and thus safe
 * to match on.
 */
export function isMyccProcess(pid: number, peerName?: string | null): boolean {
  if (!pid || typeof pid !== 'number') return false;
  if (typeof peerName !== 'string' || peerName.length === 0) return false;
  const commandLine = readProcessCommandLine(pid);
  // cannot introspect → refuse
  if (commandLine === null) return false;
  return new RegExp(`--name[= ]+${escapeRegExp(peerName)}(?:\\s|$)`).test(commandLine);
}

/** Regex-quote a peer name so regex metacharacters cannot broaden the match. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function readProcessCommandLine(pid: number): string | null {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell',
        [
          '-NoProfile', '-NonInteractive', '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
        ],
        { encoding: 'utf-8', timeout: 8_000, windowsHide: true },
      ).trim();
      return out.length > 0 ? out : null;
    }
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
      encoding: 'utf-8',
      timeout: 5_000,
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Stop a peer after positive identity checks. Prefer the PID recorded by the
 * peer's heartbeat; if that PID is missing, a registration PID is only a
 * fallback locator and must pass the same process-start-time and exact-name
 * checks before it can be signaled.
 *
 * The runtime session ID is resolved from identity.json by durable peer name.
 * Teardown resolution deliberately does not require a fresh heartbeat: a hung
 * peer can stop beating while its process still runs. An unknown/recycled PID
 * or a command line that does not claim this peer's exact name is refused.
 */
export function stopPeer(peer: Peer): string {
  // Durable name is authoritative; never guess between duplicate entries.
  let namedSid: string | null;
  try {
    namedSid = resolvePeerForStop(peer);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return `refused-ambiguous-identity: ${detail}`;
  }
  const sid = namedSid ?? peer.sessionId ?? resolveLivePeer(peer) ?? null;
  if (!sid) return 'no-session';
  peer.sessionId = sid;

  const hbPid = heartbeatPid(sid);
  const entry = readIdentityMap()[sid];
  const entryPid = typeof entry?.pid === 'number' ? entry.pid : undefined;
  if (typeof hbPid === 'number' && typeof entryPid === 'number' && hbPid !== entryPid) {
    return 'refused-pid-mismatch';
  }
  const pid = typeof hbPid === 'number' ? hbPid : entryPid;
  if (typeof pid !== 'number') return 'refused-no-recorded-pid';

  // A dead or provably recycled PID means the original peer is gone. Never
  // signal the unrelated process that happens to reuse its numeric PID.
  if (isSessionHolderDead(sid)) {
    return isPidAlive(pid) ? 'refused-recycled-pid' : 'already-stopped';
  }
  // A still-plausible PID is not enough by itself; its argv must claim this
  // exact durable peer name. Unknown command-line identity fails closed.
  if (!isMyccProcess(pid, peer.identityName ?? peer.name)) return 'refused-not-mycc';

  try {
    process.kill(pid, 'SIGTERM');
    return 'stopped';
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return e.code === 'ESRCH' ? 'already-stopped' : `kill-failed:${e.code || e.message}`;
  }
}

/**
 * Resolve an ABSOLUTE, directly-invocable `mycc` launcher for a peer terminal.
 * Order: `$MYCC_ROOT/bin` → the repo bin next to this module → the `mycc`
 * shim on PATH. Null ⇒ the caller falls back to the bare `mycc` name.
 */
export function resolveMyccLauncher(): string | null {
  // Launcher file names differ by platform: extensioned shim/exe on Windows,
  // bare extensionless binary on POSIX.
  const binNames = (root: string): string[] =>
    process.platform === 'win32'
      ? [path.join(root, 'bin', 'mycc.cmd'), path.join(root, 'bin', 'mycc.exe')]
      : [path.join(root, 'bin', 'mycc')];

  // 1. MYCC_ROOT (absolute-ized) names the tree THIS launcher started from,
  //    and the seam tests inject their fixture into.
  const candidates: string[] = [
    ...(process.env.MYCC_ROOT ? binNames(path.resolve(process.env.MYCC_ROOT)) : []),
    // 2. module-relative repo bin: three levels up from lib/ → REPO ROOT
    //    (two would stop short at scripts/bin, silently preferring a stale
    //    npm-linked PATH shim over a fresh checkout).
    ...binNames(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')),
  ];

  for (const candidate of candidates) {
    if (existsQuiet(candidate)) return candidate;
  }

  // 3. the `mycc` shim on PATH, probed absolute.
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const shim = path.join(dir, process.platform === 'win32' ? 'mycc.cmd' : 'mycc');
    if (existsQuiet(shim)) return shim;
  }
  return null;
}

/** fs.existsSync that swallows all errors (permissions, network drives). */
function existsQuiet(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** Plain background spawn shared by the `--daemon` branch and the no-terminal
 * fallback: detached so the child survives the compose CLI's exit, `stdio:'ignore'`
 * because it renders nothing, unref'd so the caller can exit. A `.cmd`/`.bat`
 * shim needs `cmd /c` (libuv cannot exec a batch file with `shell:false`). */
function asSpawnableCommand(
  command: string,
  args: readonly string[],
): { command: string; args: string[] } {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    return { command: 'cmd', args: ['/c', command, ...args] };
  }
  return { command, args: [...args] };
}

/**
 * Parse a Windows `.cmd` launcher shim into the plain argv it executes
 * (`{ prog, target }`, e.g. `node.exe` + `…/bin/mycc.js`) — or null when the
 * shape is not recognized, in which case the caller keeps the `cmd /c` wrap.
 * Spawning the target directly (instead of through the interpreter) is what
 * keeps a detached peer from popping a console (docs/peers/peer-launch-windows.md).
 */
function parseCmdShim(shimPath: string): { prog: string; target: string } | null {
  if (process.platform !== 'win32' || !/\.cmd$/i.test(shimPath)) return null;
  let text: string;
  try {
    text = fs.readFileSync(shimPath, 'utf-8');
  } catch {
    return null;
  }
  const shimDir = path.dirname(shimPath);
  const progAssigns = collectProgAssigns(text);
  // The effective command is the LAST `%*`-consuming line; walk bottom-up
  // until a line yields a parsable prog+target pair.
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('%*')) continue;
    const parsed = execSegment(lines[i], progAssigns, shimDir);
    if (parsed) return parsed;
  }
  return null;
}

/** `SET "_prog=…"` values, in appearance order (npm shims set `_prog`). */
function collectProgAssigns(text: string): string[] {
  const assigns: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*SET\s+"?_prog=(.+?)"?\s*$/i.exec(line);
    if (m) assigns.push(m[1]);
  }
  return assigns;
}

/**
 * Extract the launch argv from one batch line: the last `&`-separated segment
 * that both consumes `%*` and quotes an entry `.js`, read as the quoted pair
 * `"<prog>" "<target.js>"`. Null when no parsable pair survives.
 */
function execSegment(
  line: string,
  progAssigns: string[],
  shimDir: string,
): { prog: string; target: string } | null {
  const seg = line
    .split('&')
    .map((s) => s.trim())
    .filter((s) => s.includes('%*') && /"[^"]+\.js"/i.test(s))
    .pop();
  if (!seg) return null;
  // Inside each `"`-pair (odd split indices) = the quoted tokens.
  const toks = seg.split('"').filter((_, idx) => idx % 2 === 1);
  if (toks.length !== 2) return null;
  const [progTok, targetTok] = toks;
  if (!/\.js$/i.test(targetTok) || /\.js$/i.test(progTok)) return null;
  const progTokResolved = progTok === '%_prog%' ? (progAssigns[0] ?? null) : progTok;
  const prog = resolveProg(progTokResolved, shimDir);
  const target = resolveTarget(targetTok, shimDir);
  return prog && target ? { prog, target } : null;
}

/** Resolve the program token to an existing executable. The bare-PATH-name
 * shortcut applies BEFORE expansion (a token with no separator cannot name a
 * bundled node); OTHERWISE %~dp0%/%dp0% expand to the shim dir FIRST (npm
 * shims literally write `SET "_prog=%dp0%\node.exe"`, so the prog token often
 * still carries the variable - mirroring resolveTarget); THEN the existence
 * check + the node-fallback apply: a named-but-absent bundled `node.exe`
 * degrades to PATH `node` (npm's own IF EXIST/ELSE fallback). */
function resolveProg(progVar: string | null, shimDir: string): string | null {
  if (!progVar) return null;
  if (!/[/\\]/.test(progVar)) return progVar; // bare PATH name, resolved at spawn time
  const expanded = progVar.replace(/%~dp0|%dp0%/gi, shimDir);
  if (expanded === '') return null;
  const prog = /^[A-Za-z]:[\\/]/.test(expanded) ? expanded : path.join(shimDir, expanded);
  try {
    if (fs.existsSync(prog)) return prog;
    return /node(\.exe)?$/i.test(prog) ? 'node' : null;
  } catch {
    return null;
  }
}

/** Expand `%dp0%`/`%~dp0` (the shim's directory) and require the entry
 * script to exist on disk. */
function resolveTarget(targetTok: string, shimDir: string): string | null {
  const raw = targetTok.replace(/%~dp0|%dp0%/gi, shimDir);
  const target = /^[A-Za-z]:[\\/]/.test(raw) ? raw : path.join(shimDir, raw);
  try {
    return fs.existsSync(target) ? target : null;
  } catch {
    return null;
  }
}

/** Detached background spawn shared by the `--daemon` branch, the windowless
 * fallback, and the `spawnImpl` test seam. A parsable `.cmd` launcher is
 * spawned via its parsed real argv (never a `cmd /c` interpreter — that is
 * what pops the console); unparsable shapes keep the `cmd /c` fallback. */
function spawnDetached(
  spawnImpl: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess,
  command: string,
  args: readonly string[],
  cwd: string,
  onSpawnError: (err: Error) => void,
): void {
  const opts: SpawnOptions = {
    cwd,
    stdio: 'ignore',
    shell: false,
    // detached: the child must survive the compose CLI's exit. windowsHide
    // alone is NOT enough for a `cmd /c` wrap — see the doc above.
    detached: true,
    windowsHide: true,
  };
  const shim = parseCmdShim(command);
  const launch = shim
    ? { command: shim.prog, args: [shim.target, ...args] } // identical observable argv to `cmd /c shim args…`
    : asSpawnableCommand(command, args);
  const proc = spawnImpl(launch.command, launch.args, opts);
  proc.on('error', onSpawnError);
  proc.unref();
}

export type LaunchResult = 'started';

export interface LaunchPeerOpts {
  /** Test seam ABOVE the daemon/terminal split: a spawn-shaped function for
   * headless tests (deliberately narrowed, not `typeof spawn` — the builtin's
   * overloads reject loose test doubles). Production omits it. */
  spawnImpl?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;
  /** Test-only: overrides the beat-poll deadline (never in production). */
  timeoutMs?: number;
}

/**
 * Launch a peer — in its OWN visible terminal, or detached background —
 * decided SOLELY by the peer's launch args; liveness is judged solely by the
 * NAME-resolution poll (the terminal opener is one-shot; the spawn is unref'd).
 *
 * DEFAULT — a visible terminal window (openTerminal, the utility `/fork` uses)
 * running the peer in its FOREGROUND from the peer's workdir — fail-fast: an
 * unusable opener rejects rather than silently degrading to a windowless
 * spawn. `--daemon` — a headless service: NO window, straight to the detached
 * spawn.
 *
 * `opts.spawnImpl` routes through spawnDetached, bypassing the opener and the
 * daemon split, so headless tests can drive the poll; see LaunchPeerOpts.
 * Windows launch mechanics: docs/peers/peer-launch-windows.md.
 *
 * IDENTITY: the peer is spawned with `--name <group>:<peer>` (the durable
 * handle), NOT a pinned `--session-id`. The peer mints its OWN fresh session
 * id on boot, so the launcher CANNOT know it up front — liveness is therefore
 * judged by RESOLVING THE NAME against identity.json (resolveLivePeer), not by
 * a launcher-minted sid (which would never match the peer's real id). On
 * success the resolved sid is STAMPED onto peer.sessionId, so the post-launch
 * callers (deliverRemotes, the cmd-up liveness wait) act on the real sid.
 */
export function launchPeer(
  peer: Peer,
  opts: LaunchPeerOpts = {},
): Promise<LaunchResult> {
  return new Promise((resolve, reject) => {
    const identityName = peer.identityName ?? peer.name;
    if (!identityName) {
      reject(new Error('cannot launch a peer with no name'));
      return;
    }
    const argv = peerArgv(peer);
    const finalArgv = ['--name', identityName, ...argv];

    // ABSOLUTE launcher (see resolveMyccLauncher) — a bare `mycc` name is
    // unresolvable in the terminal's own shell.
    const launchCommand = resolveMyccLauncher() ?? 'mycc';
    const launchArgs = finalArgv;

    const spawnAt = Date.now();
    // The sid the peer was KNOWN by before this launch (if any) — we require a
    // DIFFERENT resolved sid, proving the process we just spawned registered
    // anew rather than us observing the pre-existing instance. null when the
    // peer was not running before (the common case).
    const prevSid = peer.sessionId ?? null;

    let poll: ReturnType<typeof setInterval> | null = null;
    let settled = false;
    const done = <T>(fn: (v: T) => void, arg: T): void => {
      if (settled) return;
      settled = true;
      if (poll) clearInterval(poll);
      fn(arg);
    };

    void (async () => {
      const cwd = peer.workdir as string;
      const onSpawnError = (err: Error): void =>
        done(reject, new Error(`spawn failed for "${peer.name}": ${err.message}`));
      try {
        if (opts.spawnImpl) {
          // Test seam: spawn via spawnDetached (bypasses opener + split) so a
          // headless test can drive the poll; inherits production shape.
          spawnDetached(opts.spawnImpl, launchCommand, launchArgs, cwd, onSpawnError);
        } else if (peer.parsedArgs?.daemon !== undefined) {
          // `--daemon` → headless service: no window, detached background.
          spawnDetached(spawn, launchCommand, launchArgs, cwd, onSpawnError);
        } else {
          // DEFAULT → a real, visible terminal running the peer in its
          // foreground. Fail fast, no windowless fallback: an unusable opener
          // rejects the launch with its diagnostic (what was tried, why it
          // failed) so the cause stays observable.
          // (openTerminal is one-shot fire-and-forget — its return is NOT the
          // peer's exit; liveness is the name-resolution poll below.)
          //
          // HEADLESS GUIDANCE: the windowed opener REQUIRES a desktop session
          // (a GUI terminal binary on PATH + a display). An automated caller
          // (an agent, a service, cron, CI, an SSH session with no X) has none,
          // so the opener throws — and this default branch is exactly what such
          // a caller hits, because it is the branch every non-`--daemon` peer
          // takes. The raw opener diagnostic says *what* failed but not *what to
          // do*, so we APPEND the actionable remedy: put `--daemon` in the
          // peer's spec `args` to take the headless spawnDetached path (no
          // window, ever). Appending (never replacing) preserves the opener's
          // cause — observability over availability still holds.
          try {
            openTerminal(buildPeerShellCommand(launchCommand, launchArgs, cwd));
          } catch (err) {
            const cause = err instanceof Error ? err.message : String(err);
            done(reject, new Error(
              `spawn failed for "${peer.name}": ${cause}\n` +
              `Hint: peer "${peer.name}" is not launched with --daemon, so compose ` +
              `tried to open a VISIBLE terminal window — which needs an interactive ` +
              `desktop session and is unavailable to an automated/headless caller. ` +
              `Add "--daemon" to peers[].args in the spec to launch it headless.`,
            ));
            return;
          }
        }
      } catch (err) {
        done(reject, new Error(`spawn failed for "${peer.name}": ${(err as Error).message}`));
        return;
      }

      const deadline = Date.now() + (opts.timeoutMs ?? LAUNCH_TIMEOUT_MS);
      poll = setInterval(() => {
        // Resolve the LIVE sid by durable NAME. The peer mints its own sid on
        // boot, so this is the ONLY way to learn it. Require a sid that differs
        // from the pre-launch one, so we observe the NEW instance registering
        // (not a stale still-running twin).
        const sid = resolveLivePeer(peer);
        if (sid && sid !== prevSid) {
          peer.sessionId = sid;
          done(resolve, 'started' as LaunchResult);
          return;
        }
        if (Date.now() > deadline) {
          // A peer that never beats most often means the launch never took
          // effect. When this peer was NOT `--daemon`, the launch went through
          // the windowed terminal opener, which silently does nothing under a
          // non-interactive console (no window, so the command never runs) —
          // exactly an automated caller's situation. Append the same remedy the
          // opener-throw branch gives, so the timeout is actionable too.
          const headlessHint = peer.parsedArgs?.daemon === undefined
            ? `\nHint: this peer is not launched with --daemon, so it was started ` +
              `via a VISIBLE terminal window; under a headless/non-interactive ` +
              `session no window opens and the command never runs. Add "--daemon" ` +
              `to peers[].args in the spec to launch it headless.`
            : '';
          done(reject, new Error(
            `peer "${peer.name}" did not come up within ` +
            `${opts.timeoutMs ?? LAUNCH_TIMEOUT_MS}ms (spawned at ${spawnAt}).${headlessHint}`,
          ));
        }
      }, LAUNCH_POLL_MS);
    })();
  });
}
