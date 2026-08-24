#!/usr/bin/env node
/**
 * timer.js — Periodic trigger for the lfplater-skill-manager peer.
 *
 * This is a STANDALONE Node.js script — no LLM in the trigger loop. It runs
 * as a long-lived background process (started via bg_create, a cron job, or
 * manually) and periodically:
 *
 *   1. Scans .mycc/lfplater/ for pending *.md files.
 *   2. If empty → do nothing, sleep, repeat.
 *   3. Finds a skill-manager peer in identity.json (role=="skill-manager"
 *      && workDir==cwd && fresh heartbeat).
 *   4. If not found → spawns `mycc --auto --role skill-manager
 *      --skip-healthcheck` and waits for it to register.
 *   5. Sends mail via the `mycc-mail` CLI: a batch instruction telling the
 *      peer to process the lfplater files and reply via mail_to.
 *
 * The peer stays alive in --auto mode (WAIT-polling for mail) between
 * batches — the timer does NOT tear it down. This makes repeated processing
 * efficient and decouples the trigger (deterministic) from the work (LLM).
 *
 * LIFECYCLE / ORPHAN-SAFETY:
 *   bg_create tasks survive lead death (detached + unref). So if the lead
 *   that started this timer dies, the timer keeps running as an orphan —
 *   which is fine, because it is self-managing: it discovers the peer via
 *   identity.json (not via the lead's in-memory task map) and sends mail
 *   via the mycc-mail CLI (cross-instance, not in-process).
 *
 *   To make the timer and peer killable even after the lead dies, this
 *   script writes PID files on startup:
 *     .mycc/lfplater-skill-manager-timer.pid  — this timer's PID
 *     .mycc/lfplater-skill-manager-peer.pid   — the spawned peer's PID
 *
 *   Stop the timer:  kill $(cat .mycc/lfplater-skill-manager-timer.pid)
 *   Stop the peer:   kill $(cat .mycc/lfplater-skill-manager-peer.pid)
 *   (On Windows: taskkill /F /PID <pid-from-the-file>)
 *
 * USAGE:
 *   node skills/lfplater-skill-manager/timer.js
 *   MYCC_SKILL_MANAGER_INTERVAL_MIN=10 node skills/lfplater-skill-manager/timer.js
 *
 * ENV:
 *   MYCC_SKILL_MANAGER_INTERVAL_MIN — poll interval in minutes (default 10)
 *   MYCC_SKILL_MANAGER_ROLE        — role label to match in identity.json
 *                                    (default "skill-manager")
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, execFileSync } from 'child_process';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INTERVAL_MIN = parseInt(
  process.env.MYCC_SKILL_MANAGER_INTERVAL_MIN || '10',
  10,
);
const INTERVAL_MS = (Number.isFinite(INTERVAL_MIN) && INTERVAL_MIN > 0 ? INTERVAL_MIN : 10) * 60_000;
const ROLE = process.env.MYCC_SKILL_MANAGER_ROLE || 'skill-manager';
/** Freshness window — mirrors FRESHNESS_WINDOW_MS in identity.ts. */
const FRESHNESS_WINDOW_MS = 90_000;
/** Max time to wait for a spawned peer to register in identity.json. */
const PEER_REGISTER_TIMEOUT_MS = 30_000;
const PEER_REGISTER_POLL_MS = 500;
/** Max consecutive ticks with no master (fresh lead) before self-terminating. */
const MASTER_MISS_LIMIT = 3;

const WORK_DIR = process.cwd();
const MYCC_DIR = path.join(WORK_DIR, '.mycc');
const LFPLATER_DIR = path.join(MYCC_DIR, 'lfplater');
const TIMER_PID_FILE = path.join(MYCC_DIR, 'lfplater-skill-manager-timer.pid');
const PEER_PID_FILE = path.join(MYCC_DIR, 'lfplater-skill-manager-peer.pid');

const DISCOVERY_DIR = path.join(os.homedir(), '.mycc-store', 'discovery');
const IDENTITY_FILE = path.join(DISCOVERY_DIR, 'identity.json');
const HEARTBEAT_DIR = path.join(DISCOVERY_DIR, 'heartbeat');

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  process.stdout.write(`[lfplater-timer ${ts}] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// identity.json + heartbeat readers (mirror src/peer/identity.ts)
// ---------------------------------------------------------------------------

function readIdentityMap() {
  if (!fs.existsSync(IDENTITY_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

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

function isFresh(sessionId) {
  const hb = readHeartbeats(sessionId);
  if (hb.length === 0) return false;
  return Date.now() - hb[hb.length - 1] < FRESHNESS_WINDOW_MS;
}

/**
 * Find a skill-manager peer for this workDir in identity.json.
 * Returns the session-id, or null if none found or not fresh.
 */
function findSkillManagerPeer() {
  const map = readIdentityMap();
  for (const entry of Object.values(map)) {
    if (entry.role !== ROLE) continue;
    if (entry.workDir !== WORK_DIR) continue;
    if (!isFresh(entry.sessionId)) continue;
    return entry.sessionId;
  }
  return null;
}

/**
 * Find a "master" lead for this workDir in identity.json.
 *
 * A master is a fresh identity entry for this workDir whose role is NOT the
 * skill-manager role (i.e. a productivity lead — role absent, or a different
 * role). The skill-manager peer itself is NOT a master. This is the
 * orphan-detection signal: if no master is found for MASTER_MISS_LIMIT
 * consecutive ticks, the timer self-terminates (the lead that started it is
 * gone and was not restarted).
 *
 * Returns true if a fresh master is found, false otherwise.
 */
function findMasterLead() {
  const map = readIdentityMap();
  for (const entry of Object.values(map)) {
    if (entry.workDir !== WORK_DIR) continue;
    if (entry.role === ROLE) continue; // skip skill-manager peers
    if (!isFresh(entry.sessionId)) continue;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// lfplater scan
// ---------------------------------------------------------------------------

function countLfplaterFiles() {
  if (!fs.existsSync(LFPLATER_DIR)) return 0;
  try {
    return fs.readdirSync(LFPLATER_DIR).filter(f => f.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Peer spawning
// ---------------------------------------------------------------------------

/**
 * Spawn a headless skill-manager peer.
 *
 * `mycc` is a .cmd shim on Windows. Per the DEP0190 pitfall, we use
 * shell:true with a full command string (not an args array) to avoid the
 * Node.js deprecation warning and ensure the .cmd shim resolves.
 *
 * Returns the spawned ChildProcess (detached so it survives this timer).
 */
function spawnPeer() {
  const cmd = `mycc --auto --role ${ROLE} --skip-healthcheck`;
  const isWin = process.platform === 'win32';
  const child = isWin
    ? spawn(cmd, [], { cwd: WORK_DIR, shell: true, detached: true, windowsHide: true })
    : spawn(cmd, [], { cwd: WORK_DIR, shell: true, detached: true });

  child.unref();
  child.stdout?.on('data', () => {}); // drain
  child.stderr?.on('data', () => {}); // drain

  if (child.pid !== undefined) {
    try {
      fs.writeFileSync(PEER_PID_FILE, String(child.pid), 'utf-8');
    } catch {
      // best-effort — PID file is for manual cleanup, not critical
    }
  }
  return child;
}

/**
 * Wait for a freshly-spawned peer to register in identity.json.
 * Polls every PEER_REGISTER_POLL_MS up to PEER_REGISTER_TIMEOUT_MS.
 * Returns the session-id, or null on timeout.
 */
function waitForPeerRegistration() {
  const deadline = Date.now() + PEER_REGISTER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const sid = findSkillManagerPeer();
    if (sid) return sid;
    const elapsed = Date.now() + PEER_REGISTER_POLL_MS;
    while (Date.now() < elapsed) { /* busy-wait 500ms */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mail delivery (via mycc-mail CLI)
// ---------------------------------------------------------------------------

/**
 * Locate the mycc-mail CLI. It's a declared bin in the mycc package, so
 * after `npm link` it's on PATH. Fall back to the script path in this repo.
 */
function findMyccMailBin() {
  // Try the repo-relative script (works during development / from source).
  const repoScript = path.resolve(__dirname, '..', '..', 'scripts', 'mycc-mail', 'mycc-mail.js');
  if (fs.existsSync(repoScript)) {
    return { bin: process.execPath, args: [repoScript] };
  }
  // Fall back to the global bin (post `npm link` / global install).
  return { bin: 'mycc-mail', args: [] };
}

/**
 * Send a batch mail to the skill-manager peer via mycc-mail.
 * Returns true on success, false on failure.
 */
function sendBatchMail(peerSessionId, fileCount) {
  const { bin, args } = findMyccMailBin();
  const title = 'lfplater batch';
  const content =
    `Process ${fileCount} pending lfplater file(s) in .mycc/lfplater/. ` +
    `Read each, search/create/optimize skills via skill_search + create-skill, ` +
    `merge duplicates, delete consumed files, then report back. ` +
    `Reply via mail_to(name="${process.env.MYCC_SESSION_ID || 'unknown'}/lead", ` +
    `title="skill-manager report", content="..."). ` +
    `Load the workflow: skill_load(name="lfplater-skill-manager").`;
  const allArgs = [...args, peerSessionId, '--title', title, '--content', content];
  try {
    execFileSync(bin, allArgs, { cwd: WORK_DIR, stdio: 'pipe', encoding: 'utf-8' });
    return true;
  } catch (err) {
    log(`mycc-mail failed: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

/** Consecutive ticks with no fresh master lead found. Reset to 0 when a
 *  master is found. When this reaches MASTER_MISS_LIMIT, the timer
 *  self-terminates (the lead that started it is gone and not restarted). */
let masterMissCount = 0;

function tick() {
  // Orphan check: is a master lead still alive for this workDir?
  if (!findMasterLead()) {
    masterMissCount++;
    log(`no master lead found (miss ${masterMissCount}/${MASTER_MISS_LIMIT})`);
    if (masterMissCount >= MASTER_MISS_LIMIT) {
      log(`no master for ${MASTER_MISS_LIMIT} consecutive ticks — self-terminating`);
      try { fs.unlinkSync(TIMER_PID_FILE); } catch { /* best-effort */ }
      process.exit(0);
    }
    return; // skip this tick — don't process lfplater or spawn a peer
  }
  masterMissCount = 0; // master alive — reset the miss counter

  const fileCount = countLfplaterFiles();
  if (fileCount === 0) {
    log('no lfplater files — idle');
    return;
  }

  log(`${fileCount} lfplater file(s) pending — looking for skill-manager peer`);
  let peerSid = findSkillManagerPeer();

  if (!peerSid) {
    log('no fresh skill-manager peer found — spawning one');
    spawnPeer();
    peerSid = waitForPeerRegistration();
    if (!peerSid) {
      log('ERROR: spawned peer did not register within timeout — will retry next tick');
      return;
    }
    log(`peer registered: session=${peerSid}`);
  } else {
    log(`found existing peer: session=${peerSid}`);
  }

  log(`sending batch mail to ${peerSid}`);
  const ok = sendBatchMail(peerSid, fileCount);
  if (ok) {
    log('batch mail delivered');
  } else {
    log('batch mail delivery failed — will retry next tick');
  }
}

function main() {
  // Write our own PID file for manual cleanup after lead death.
  try {
    fs.mkdirSync(MYCC_DIR, { recursive: true });
    fs.writeFileSync(TIMER_PID_FILE, String(process.pid), 'utf-8');
  } catch {
    // best-effort
  }

  log(`started (interval=${INTERVAL_MIN}min, role=${ROLE}, workDir=${WORK_DIR})`);
  log(`PID file: ${TIMER_PID_FILE}`);

  // Clean up PID file on exit.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      try { fs.unlinkSync(TIMER_PID_FILE); } catch { /* best-effort */ }
      process.exit(0);
    });
  }

  // Fire once immediately, then on the interval.
  tick();
  setInterval(tick, INTERVAL_MS);
}

main();