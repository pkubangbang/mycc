#!/usr/bin/env node
/**
 * mycc-mail.js — Global CLI for cross-instance / cronjob-triggered mail delivery.
 *
 * Sends a single mail to a target mycc lead's mailbox by appending a JSONL
 * line to the lead's `unread-lead.jsonl`. The target is identified by session-id;
 * its mailbox path is looked up from `~/.mycc-store/discovery/identity.json`
 * (the same registry the `peers` tool and `ctx.peer.sendPeerMail` use).
 *
 * This is the cross-instance counterpart to the in-process `mail_to` tool.
 * The `mail_to` tool is scoped to intra-session communication (lead ↔
 * teammates within one mycc instance); `mycc-mail` handles everything that
 * comes from OUTSIDE the agent process — cron scripts, other mycc instances
 * (the mediator pattern), or a human operator.
 *
 * Exposed as the `mycc-mail` bin by the parent mycc package (see
 * ../../package.json `bin`). After `npm link` (or a global install of mycc),
 * the `mycc-mail` command is on PATH and works from any directory:
 *
 *   mycc-mail <session-id> --title "Subject" --content "Body"
 *   mycc-mail <session-id> --title "Subject" --content-file message.txt
 *   mycc-mail <session-id> --title "Subject" --content "Body" --from "cron"
 *   mycc-mail --list                  list online instances (from identity.json)
 *   mycc-mail --help                 show this help
 *
 * Mail JSONL format (matches src/context/shared/mail.ts appendMail and
 * src/peer/channel.ts appendMailToPath):
 *   {"id":"<8-char>","from":"mycc-mail","title":"<title>","content":"<content>","timestamp":"<ISO-8601>"}
 *
 * Run directly during development:
 *   node scripts/mycc-mail/mycc-mail.js <session-id> --title "..." --content "..."
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

// ---------------------------------------------------------------------------
// Constants — must mirror src/config.ts and src/peer/identity.ts
// ---------------------------------------------------------------------------

const DISCOVERY_DIR = path.join(os.homedir(), '.mycc-store', 'discovery');
const IDENTITY_FILE = path.join(DISCOVERY_DIR, 'identity.json');
const HEARTBEAT_DIR = path.join(DISCOVERY_DIR, 'heartbeat');
/** Absolute freshness window — mirrors FRESHNESS_WINDOW_MS in identity.ts. */
const FRESHNESS_WINDOW_MS = 90_000;

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

const HELP = `mycc-mail — cross-instance mail delivery for mycc

Sends a mail to a target mycc lead's mailbox by appending a JSONL line to
the lead's unread-lead.jsonl. The target is identified by session-id; its
mailbox path is looked up from ~/.mycc-store/discovery/identity.json (the
same registry the \`peers\` tool uses). The target mycc instance must be
running and registered; if it is in --auto mode it will pick the mail up
on its next 1-second WAIT poll and process it automatically.

Usage:
  mycc-mail <session-id> --title "Subject" --content "Body"
  mycc-mail <session-id> --title "Subject" --content-file message.txt
  mycc-mail <session-id> --title "Subject" --content "Body" --from "cron"
  mycc-mail --list                       List online mycc instances
  mycc-mail --help, -h                   Show this help

Options:
  --title <s>        Mail subject (required for send).
  --content <s>      Mail body (required for send, or use --content-file).
  --content-file <p> Read mail body from a file (use instead of --content).
  --from <s>         Sender identity recorded in the mail (default: "mycc-mail").
  --require-online   Refuse delivery unless the lead is PROVABLY live
                     (fresh heartbeat AND recorded pid alive). Exits 1 with a
                     "liveness gate" message and NEVER appends the mail when
                     the gate fails. Used by mycc-compose remotes delivery.
  --list             List registered mycc instances (session-id, workDir, fresh).
  --help, -h         Show this help.

Exit codes: 0 = OK, 1 = delivery error, 2 = usage error.

Mail format (one JSONL line appended to the target's unread-lead.jsonl):
  {"id":"<8-char>","from":"<from>","title":"<title>","content":"<content>","timestamp":"<ISO-8601>"}

Cronjob example:
  # Start mycc in auto mode
  mycc --auto --skip-healthcheck
  # Discover the session-id
  mycc-mail --list
  # Send mail from a cron script
  mycc-mail <session-id> --title "Daily build" --content "Run the build and report."
`;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function dieUsage(msg) {
  process.stderr.write(`${msg}\n\n${HELP}`);
  process.exit(2);
}

function dieError(msg) {
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Identity + heartbeat readers (mirror src/peer/identity.ts read logic)
// ---------------------------------------------------------------------------

/**
 * Read identity.json into a session-keyed map. Returns {} if missing/malformed.
 */
function readIdentityMap() {
  if (!fs.existsSync(IDENTITY_FILE)) return {};
  try {
    const content = fs.readFileSync(IDENTITY_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

/**
 * Read a session's heartbeat timestamps. Accepts both the current
 * {heartbeats: [...]} and legacy {timestamps: [...]} schemas.
 * Returns [] if missing/malformed.
 */
function readHeartbeats(sessionId) {
  const hbFile = path.join(HEARTBEAT_DIR, `${sessionId}.json`);
  if (!fs.existsSync(hbFile)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(hbFile, 'utf-8'));
    if (Array.isArray(parsed.timestamps)) return parsed.timestamps;
    if (Array.isArray(parsed.heartbeats)) return parsed.heartbeats;
    return [];
  } catch {
    return [];
  }
}

/**
 * Is the session fresh (online)? Mirrors the absolute-window check in
 * IdentityManager.isFresh(): latest heartbeat within FRESHNESS_WINDOW_MS.
 * A registered session with no heartbeat file is treated as stale (the
 * CLI is conservative — it warns the caller rather than assuming liveness).
 */
function isFresh(sessionId) {
  const heartbeats = readHeartbeats(sessionId);
  if (heartbeats.length === 0) return false;
  const latest = heartbeats[heartbeats.length - 1];
  return Date.now() - latest < FRESHNESS_WINDOW_MS;
}

/**
 * The pid recorded in a session's heartbeat file, or undefined when the file
 * carries no `pid` field. Mirrors heartbeatPid() in scripts/mycc-compose/lib/
 * discovery.ts — the heartbeat `pid` is stamped by the recording process on
 * every beat (IdentityManager.beat()), so a fresh file naming a live pid is
 * positive evidence a mycc instance owns that pid (unlike "some pid is alive",
 * which a recycled pid also satisfies).
 *
 * Accepts both the current {heartbeats:[], pid:N} and legacy {timestamps:[],
 * pid:N} schemas; returns undefined for a malformed/missing file or a
 * non-numeric pid.
 */
function readHeartbeatPid(sessionId) {
  const hbFile = path.join(HEARTBEAT_DIR, `${sessionId}.json`);
  if (!fs.existsSync(hbFile)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(hbFile, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return undefined;
    return typeof parsed.pid === 'number' ? parsed.pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when `pid` looks like a live process. Cross-platform: `process.kill(
 * pid, 0)` sends no signal but throws if the pid is gone (ESRCH) or invalid.
 * EPERM means the process exists but is not ours to signal → treat as alive
 * (mirrors isPidAlive() in scripts/mycc-compose/lib/discovery.ts).
 */
function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err instanceof Error && err.code === 'EPERM';
  }
}

/**
 * Is a peer PROVABLY running? Fresh heartbeat AND the recorded pid is alive.
 *
 * DELIBERATELY FAIL-CLOSED, diverging from discovery.ts:279 `isPeerRunning`,
 * which falls back to "trust freshness" when no pid is recorded (it would
 * rather risk double-starting a peer than refuse to restart a live one). The
 * mailer is the opposite case: delivering remotes to a peer that is NOT
 * provably live orphans mail in a mailbox the lead may never read (a crashed
 * lead leaves a fresh-but-dead heartbeat within the 90s window). So when no
 * pid is recorded we REFUSE — we must not append mail on a guess.
 *
 * Used by BOTH the `--require-online` send gate and `cmdList` status, so the
 * two can never contradict (a session that prints "online (live)" here is
 * exactly one `--require-online` would accept).
 */
function isPeerRunning(sessionId) {
  if (!isFresh(sessionId)) return false;
  const pid = readHeartbeatPid(sessionId);
  if (typeof pid !== 'number') return false; // fail-closed: no pid → refuse
  return isPidAlive(pid);
}

// ---------------------------------------------------------------------------
// Mail append (mirrors src/peer/channel.ts appendMailToPath)
// ---------------------------------------------------------------------------

/**
 * Generate an 8-char mail id. Matches MailBox.generateId in mail.ts and
 * generateMailId in channel.ts: Math.random().toString(36).substring(2, 10).
 */
function generateMailId() {
  return Math.random().toString(36).substring(2, 10);
}

/**
 * Append a single JSONL mail line to a mailbox file path.
 * Matches the format written by MailBox.appendMail (mail.ts) and
 * appendMailToPath (channel.ts) so the target lead's COLLECT state
 * consumes it identically to in-process mail.
 */
function appendMailToPath(mailboxPath, from, title, content) {
  const dir = path.dirname(mailboxPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const mail = {
    id: generateMailId(),
    from,
    title,
    content,
    timestamp: new Date().toISOString(),
  };
  const line = `${JSON.stringify(mail)}\n`;
  fs.appendFileSync(mailboxPath, line, 'utf-8');
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

function cmdList() {
  const map = readIdentityMap();
  const entries = Object.values(map);
  if (entries.length === 0) {
    process.stdout.write(
      'No mycc instances registered for peer discovery.\n' +
      '(Run `mycc` to register an instance; discovery is via\n' +
      `${IDENTITY_FILE}.)\n`,
    );
    process.exit(0);
  }

  const rows = [];
  let online = 0;
  for (const entry of entries) {
    // Status mirrors the --require-online gate (isPeerRunning: fresh heartbeat
    // AND recorded pid alive), NOT the heartbeat-only isFresh. A fresh-but-
    // dead-pid session would otherwise print "online" here while --require-
    // online refuses it — the two must never contradict. The parenthetical
    // surfaces WHY (live / stale heartbeat / dead pid) so a human can tell a
    // crashed-within-90s lead from a never-started one.
    const fresh = isFresh(entry.sessionId);
    const running = isPeerRunning(entry.sessionId);
    if (running) online++;
    let status;
    if (running) {
      status = 'online (live)';
    } else if (fresh) {
      status = 'offline (fresh heartbeat, dead pid)';
    } else {
      status = 'offline (stale heartbeat)';
    }
    const started = new Date(entry.startedAt).toISOString().replace('T', ' ').slice(0, 19);
    rows.push(
      `- session=${entry.sessionId}\n` +
      `    workDir: ${entry.workDir}\n` +
      `    status: ${status}\n` +
      `    started: ${started}`,
    );
  }
  const summary = `${online} online, ${entries.length} registered`;
  process.stdout.write(`mycc instances (${summary}):\n${rows.join('\n')}\n`);
  process.exit(0);
}

function cmdSend(args) {
  const sessionId = args.sessionId;
  const title = args.title;
  let content = args.content;

  // --content-file overrides --content
  if (args.contentFile) {
    if (!fs.existsSync(args.contentFile)) {
      dieError(`content file not found: ${args.contentFile}`);
    }
    content = fs.readFileSync(args.contentFile, 'utf-8');
  }

  if (!title) dieUsage('send: --title is required');
  if (content === undefined || content === null || content === '') {
    dieUsage('send: --content (or --content-file) is required');
  }

  // Look up mailbox path from identity.json
  const map = readIdentityMap();
  const entry = map[sessionId];
  if (!entry) {
    if (args.requireOnline) {
      dieError(
        `liveness gate: session ${sessionId} not found in ${IDENTITY_FILE} ` +
        `(unregistered). --require-online refuses to deliver to an unregistered lead.`,
      );
    }
    dieError(
      `session ${sessionId} not found in ${IDENTITY_FILE}.\n` +
      `Use \`mycc-mail --list\` to see registered instances. ` +
      `The target mycc must be running (it registers itself at startup).`,
    );
  }
  const mailboxPath = entry.mailbox;
  if (!mailboxPath) {
    dieError(`session ${sessionId} has no mailbox path in identity.json (malformed entry).`);
  }

  // --require-online: FAIL-CLOSED liveness gate. The mail is appended ONLY when
  // the lead is PROVABLY live — fresh heartbeat AND the recorded pid is alive
  // (isPeerRunning, fail-closed on a missing pid). A fresh-but-dead heartbeat
  // (a lead that crashed within the 90s window) or a stale heartbeat would
  // otherwise leave remotes mail orphaned in a mailbox the lead never reads.
  // The gate NEVER appends on failure: dieError exits 1 before appendMailToPath.
  if (args.requireOnline) {
    if (!isPeerRunning(sessionId)) {
      const fresh = isFresh(sessionId);
      const pid = readHeartbeatPid(sessionId);
      const why = !fresh
        ? 'stale heartbeat'
        : (typeof pid !== 'number' ? 'no pid recorded' : `pid ${pid} not alive`);
      dieError(
        `liveness gate: session ${sessionId} is not provably live (${why}). ` +
        `--require-online refuses to deliver to a lead that may not read the mail.`,
      );
    }
  } else if (!isFresh(sessionId)) {
    // Freshness warning (non-fatal — the mail will still be delivered; if the
    // lead is down it sits in the file until the lead restarts and processes it,
    // or gets orphaned if the session is abandoned).
    process.stderr.write(
      `Warning: session ${sessionId} appears offline (no fresh heartbeat).\n` +
      `The mail is still appended to the mailbox; it will be processed when\n` +
      `the lead next runs COLLECT (or on restart if the session is resumed).\n`,
    );
  }

  const from = args.from || 'mycc-mail';
  appendMailToPath(mailboxPath, from, title, content);

  process.stdout.write(
    `OK. Mail delivered to session ${sessionId}:\n` +
    `  from:    ${from}\n` +
    `  title:   ${title}\n` +
    `  mailbox: ${mailboxPath}\n`,
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

/**
 * Minimal arg parser. Recognizes:
 *   --flag value
 *   --flag=value
 *   bare token (first one becomes the session-id positional)
 *
 * Keeps the script dependency-free (no minimist import) so it runs from any
 * directory after `npm link` without resolving node_modules.
 */
function parseArgs(argv) {
  const args = { sessionId: null, title: null, content: null, contentFile: null, from: null, requireOnline: false, list: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--help' || tok === '-h') { args.help = true; continue; }
    if (tok === '--list') { args.list = true; continue; }
    if (tok === '--require-online') { args.requireOnline = true; continue; }
    // --key value  or  --key=value
    const eqIdx = tok.indexOf('=');
    let key = tok;
    let inlineVal = null;
    if (eqIdx > 0) {
      key = tok.slice(0, eqIdx);
      inlineVal = tok.slice(eqIdx + 1);
    }
    const knownKeys = ['--title', '--content', '--content-file', '--from'];
    if (knownKeys.includes(key)) {
      let val = inlineVal;
      if (val === null) {
        // value is the next token
        i++;
        val = argv[i];
        if (val === undefined) dieUsage(`${key} requires a value`);
      }
      const fieldMap = {
        '--title': 'title',
        '--content': 'content',
        '--content-file': 'contentFile',
        '--from': 'from',
      };
      args[fieldMap[key]] = val;
      continue;
    }
    // Unknown flag (starts with --) — reject to surface typos
    if (tok.startsWith('--')) {
      dieUsage(`unknown option: ${tok}`);
    }
    // Positional: first bare token is the session-id
    if (args.sessionId === null) {
      args.sessionId = tok;
    } else {
      dieUsage(`unexpected extra argument: ${tok}`);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (args.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  if (args.list) {
    cmdList();
    return;
  }

  if (!args.sessionId) {
    dieUsage('no <session-id> given (or use: mycc-mail --list / mycc-mail --help)');
  }

  cmdSend(args);
}

main();