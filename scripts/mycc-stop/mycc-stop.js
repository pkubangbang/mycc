#!/usr/bin/env node
/**
 * mycc-stop.js — stop / list mycc peers (CLI entry).
 *
 * Thin CLI shim: registers the tsx ESM loader, dynamically imports the shared
 * mycc-compose lib (`stopPeerByAddress`, `stopPeerBySid`, and the discovery
 * readers for the listing form), and dispatches on the arguments.
 *
 * THREE FORMS
 * -----------
 *   1. ADDRESS (full-spell)   mycc-stop --group <g> --name <n> [--cwd <dir>]
 *      Stops ONE peer by its durable address. `--cwd` defaults to the current
 *      directory; `--group` and `--name` are MANDATORY and always spelled out
 *      (never a joined `group:name` key — that concatenation is only the wire
 *      form the LAUNCHER injects as `--name`, and no human types it).
 *
 *   2. SESSION ID             mycc-stop --session-id=<full-uuid>
 *      Stops ONE peer directly by its runtime session id (no cwd/group/name).
 *      The id must be a FULL-LENGTH uuid; an abbreviated or malformed id is
 *      rejected with "not a well-formed session-id" (fail loud, never a partial
 *      match against a prefix).
 *
 *   3. LIST (bare)            mycc-stop
 *      With no arguments, prints every running peer (live identity entries).
 *
 * Usage (two ways to name a peer to stop, plus a listing form):
 *   mycc-stop --group <g> --name <n> [--cwd <dir>]   stop by durable ADDRESS
 *   mycc-stop --session-id <full-uuid>               stop by SESSION ID
 *   mycc-stop                                        list running peers
 *   mycc-stop --help
 *
 * Exit codes:
 *   0  not running (stopped / already-stopped / refused-not-found); or, for the
 *      listing form, always 0. Decision (i): a non-running peer is NOT an error.
 *   1  a genuine refusal/failure (refused-*, still-up), or a malformed session-id
 *   2  usage error (missing --group/--name, unknown option)
 *
 * NOTES ON `--session-id` (same SPELLING, DIFFERENT SURFACES)
 * ----------------------------------------------------------
 * This flag is REJECTED on `mycc` itself (src/config.ts: sessions are never
 * reused, so the boot flag `mycc --session-id ...` is a silent no-op) — that is
 * the LAUNCH flag. Here it is a different program with a different meaning: the
 * TARGET selector for a stop. They share the spelling deliberately (it is the
 * same concept — a session id) but live on separate binaries, so there is no
 * collision. This surface VALIDATES the id (full-length uuid) and fails loud.
 *
 * Run directly during development:
 *   node scripts/mycc-stop/mycc-stop.js --group pr26 --name reviewer
 */

import { register } from 'tsx/esm/api';

register();

const { stopPeerByAddress, stopPeerBySid } = await import('../mycc-compose/lib/index.ts');
const discovery = await import('../mycc-compose/lib/discovery.ts');
const path = await import('path');

const HELP = `mycc-stop — stop / list mycc peers

SYNOPSIS (two ways to name a peer to stop, plus a listing form):
  mycc-stop --group <g> --name <n> [--cwd <dir>]      stop by durable ADDRESS
  mycc-stop --session-id <full-uuid>                  stop by SESSION ID
  mycc-stop                                           list running peers
  mycc-stop --help, -h                                show this help

Form 1 — ADDRESS (stop one peer by its durable address)
  mycc-stop --group <g> --name <n> [--cwd <dir>]
  --cwd defaults to the current directory. --group and --name are MANDATORY and
  spelled separately (never a joined "group:name" key). Matching is RIGID: the
  entry's workdir must equal --cwd AND its durable name must equal
  "<group>:<name>" exactly. No fallback.

Form 2 — SESSION ID (stop one peer by its runtime session id)
  mycc-stop --session-id <full-uuid>
  No cwd/group/name needed. The id must be a FULL-LENGTH uuid; a short or
  malformed id is rejected as "not a well-formed session-id".

Form 3 — LIST (no arguments)
  mycc-stop
  Prints every running peer (live identity entries).

Exit codes:
  0  not running (stopped / already-stopped / refused-not-found) / listing OK
  1  refused-*, still-up, or a malformed session-id
  2  usage error
`;

/** Full-length uuid (the shape a real session id has). Mirrors spec.ts UUID_RE;
 * declared here so the shim does not import the compose spec module just for
 * one regex. The user-facing rule: the LONG form is required — a short id is a
 * hard error, never a prefix match. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse argv. Throws a usage Error on bad input. Recognizes the three forms. */
function parseArgs(argv) {
  const out = { cwd: process.cwd(), group: null, name: null, sessionId: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--help' || tok === '-h') { out.help = true; continue; }
    // Accept both `--flag value` and `--flag=value`.
    const eq = tok.indexOf('=');
    const key = eq === -1 ? tok : tok.slice(0, eq);
    const inlineVal = eq === -1 ? null : tok.slice(eq + 1);
    const takeValue = () => {
      if (inlineVal !== null) return inlineVal;
      const v = argv[++i];
      if (v === undefined) throw new Error(`option ${key} requires a value`);
      return v;
    };
    switch (key) {
      case '--cwd': out.cwd = takeValue(); break;
      case '--group': out.group = takeValue(); break;
      case '--name': out.name = takeValue(); break;
      case '--session-id': out.sessionId = takeValue(); break;
      default: throw new Error(`unknown option: ${tok}`);
    }
  }
  return out;
}

function dieUsage(msg) {
  process.stderr.write(`${msg}\n\n${HELP}`);
  process.exit(2);
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  dieUsage(err instanceof Error ? err.message : String(err));
}

if (args.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

// ── Form 3: LIST (no args) ───────────────────────────────────────────────────
// Bare `mycc-stop` prints every running peer. A "running" peer is a live
// identity entry (fresh heartbeat AND a live recorded pid) — the same predicate
// the rest of mycc uses for "reachable".
const hasStopSelector = args.sessionId !== null || args.group !== null || args.name !== null;
if (!hasStopSelector) {
  const map = discovery.readIdentityMap();
  const rows = [];
  for (const sid of Object.keys(map)) {
    if (!discovery.isPeerRunning({ sessionId: sid })) continue;
    const entry = map[sid];
    const name = typeof entry.name === 'string' && entry.name ? entry.name : '(unnamed)';
    const cwd = entry.workDir ?? entry.workdir ?? '(unknown)';
    rows.push(`  ${name}  session=${sid}  cwd=${cwd}`);
  }
  if (rows.length === 0) {
    process.stdout.write('no running peers\n');
  } else {
    process.stdout.write(`running peers (${rows.length}):\n${rows.join('\n')}\n`);
  }
  process.exit(0);
}

// ── Form 2: SESSION ID ───────────────────────────────────────────────────────
// Stop directly by sid. The id must be a full-length uuid — an abbreviated or
// otherwise malformed id fails loud rather than resolving a prefix.
if (args.sessionId !== null) {
  if (!UUID_RE.test(args.sessionId)) {
    process.stderr.write(`not a well-formed session-id: ${JSON.stringify(args.sessionId)}\n`);
    process.exit(1);
  }
  const { verdict } = await stopPeerBySid(args.sessionId);
  switch (verdict) {
    case 'stopped':
      process.stdout.write(`stopped session ${args.sessionId}\n`);
      process.exit(0);
    case 'already-stopped':
      process.stdout.write(`session ${args.sessionId} is not running (already stopped)\n`);
      process.exit(0);
    case 'refused-not-found':
      process.stdout.write(`session ${args.sessionId} is not running (no identity entry)\n`);
      process.exit(0);
    default:
      process.stderr.write(`refused session ${args.sessionId}: ${verdict}\n`);
      process.exit(1);
  }
}

// ── Form 1: ADDRESS ──────────────────────────────────────────────────────────
if (!args.group) dieUsage('--group is required (or use --session-id, or no args to list)');
if (!args.name) dieUsage('--name is required (or use --session-id, or no args to list)');

// Resolve --cwd to an absolute path (the primitive compares normalized absolute
// workdirs; a relative --cwd would never match an absolute identity entry).
const cwd = path.resolve(args.cwd);

const { verdict } = await stopPeerByAddress({ cwd, group: args.group, name: args.name });

switch (verdict) {
  case 'stopped':
    process.stdout.write(`stopped ${args.group}:${args.name} (${cwd})\n`);
    process.exit(0);
  case 'already-stopped':
    process.stdout.write(`${args.group}:${args.name} is not running (already stopped)\n`);
    process.exit(0);
  case 'refused-not-found':
    process.stdout.write(`${args.group}:${args.name} is not running (no identity entry in ${cwd})\n`);
    process.exit(0);
  default:
    process.stderr.write(`refused ${args.group}:${args.name}: ${verdict}\n`);
    process.exit(1);
}
