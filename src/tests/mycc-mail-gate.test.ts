/**
 * mycc-mail-gate.test.ts — `--require-online` fail-closed liveness gate.
 *
 * Spawns scripts/mycc-mail/mycc-mail.js as a CHILD PROCESS against an isolated
 * temp HOME (USERPROFILE on Windows, HOME on Unix — both set so os.homedir()
 * resolves to the temp dir on either platform). Each test fixtures the
 * discovery store (identity.json + heartbeat/<sid>.json) and asserts:
 *   - the exit code (0 = delivered, 1 = liveness gate refused),
 *   - whether the mailbox file was appended (gate must NEVER append on fail),
 *   - the "liveness gate" marker in stderr on refusal.
 *
 * The gate is FAIL-CLOSED and DELIBERATELY diverges from discovery.ts:279
 * `isPeerRunning`, which trusts freshness when no pid is recorded. The mailer
 * refuses instead: delivering remotes to a lead that is not provably live
 * orphans mail in a mailbox the lead may never read. These tests pin that
 * divergence so a future edit cannot silently relax it back to "trust
 * freshness".
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAILER = path.resolve(__dirname, '..', '..', 'scripts', 'mycc-mail', 'mycc-mail.js');
const SID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/** A mailbox path inside the temp HOME (must match what identity.json points at). */
function mailboxIn(home: string): string {
  return path.join(home, '.mycc-store', 'sessions', SID, 'unread-lead.jsonl');
}

/**
 * Write the discovery fixtures (identity.json + heartbeat) for one scenario.
 * `hb` is the heartbeat document to write (or null to write no heartbeat file).
 */
function fixture(home: string, hb: { heartbeats: number[]; pid?: number } | null) {
  const disc = path.join(home, '.mycc-store', 'discovery');
  fs.mkdirSync(disc, { recursive: true });
  fs.mkdirSync(path.join(disc, 'heartbeat'), { recursive: true });
  fs.mkdirSync(path.dirname(mailboxIn(home)), { recursive: true });

  // identity.json: one session entry pointing at the mailbox.
  const identity: Record<string, { sessionId: string; mailbox: string; workDir: string; startedAt: string }> = {};
  identity[SID] = { sessionId: SID, mailbox: mailboxIn(home), workDir: home, startedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(disc, 'identity.json'), JSON.stringify(identity, null, 2), 'utf-8');

  if (hb) {
    fs.writeFileSync(path.join(disc, 'heartbeat', `${SID}.json`), JSON.stringify(hb), 'utf-8');
  }
}

/**
 * Spawn the mailer with --require-online against `home` as the HOME dir.
 * Returns { status, stderr, mailboxLines }.
 */
function run(home: string, extraArgs: string[] = []) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // os.homedir() reads USERPROFILE on Windows, HOME on POSIX. Set both so the
  // child resolves homedir to our temp dir on either platform.
  env.USERPROFILE = home;
  env.HOME = home;
  const res = spawnSync(
    process.execPath,
    [MAILER, SID, '--title', 'remotes', '--content', 'dial http://1.2.3.4:3191', '--from', 'mycc-compose', '--require-online', ...extraArgs],
    { encoding: 'utf-8', env, windowsHide: true, timeout: 15_000 },
  );
  const mb = mailboxIn(home);
  let mailboxLines: string[] = [];
  if (fs.existsSync(mb)) {
    mailboxLines = fs.readFileSync(mb, 'utf-8').split('\n').filter((l) => l.trim() !== '');
  }
  return { status: res.status, stderr: res.stderr || '', stdout: res.stdout || '', mailboxLines };
}

describe('mycc-mail --require-online liveness gate', () => {
  it('REFUSES + non-zero when the heartbeat is STALE', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-mail-stale-'));
    fixture(home, { heartbeats: [Date.now() - 200_000], pid: process.pid }); // 200s ago > 90s window
    const { status, stderr, mailboxLines } = run(home);
    expect(status).toBe(1);
    expect(stderr).toMatch(/liveness gate/);
    expect(stderr).toMatch(/stale heartbeat/);
    expect(mailboxLines).toHaveLength(0); // NEVER appended
  });

  it('REFUSES + non-zero when the heartbeat is fresh but the pid is DEAD', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-mail-deadpid-'));
    // A pid that is certainly not alive. 1 is init/System on Unix (we may lack
    // permission, but isPidAlive treats EPERM as alive) — so use a pid in the
    // recycled high range that no real process holds. process.kill(999_999, 0)
    // throws ESRCH on both platforms → isPidAlive returns false.
    fixture(home, { heartbeats: [Date.now()], pid: 999_999 });
    const { status, stderr, mailboxLines } = run(home);
    expect(status).toBe(1);
    expect(stderr).toMatch(/liveness gate/);
    expect(stderr).toMatch(/pid 999999 not alive|not alive/);
    expect(mailboxLines).toHaveLength(0);
  });

  it('REFUSES + non-zero when the heartbeat has NO pid recorded (fail-closed)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-mail-nopid-'));
    // Fresh heartbeat but no pid field — the gate must refuse (deliberate
    // divergence from discovery.ts:279's "trust freshness" fallback).
    fixture(home, { heartbeats: [Date.now()] });
    const { status, stderr, mailboxLines } = run(home);
    expect(status).toBe(1);
    expect(stderr).toMatch(/liveness gate/);
    expect(stderr).toMatch(/no pid recorded/);
    expect(mailboxLines).toHaveLength(0);
  });

  it('REFUSES + non-zero when the sid is NOT in identity.json (unregistered)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-mail-unreg-'));
    // Fresh + live pid, but NO identity entry for the sid. The unregistered
    // branch under --require-online must exit 1 with the liveness-gate marker.
    fixture(home, { heartbeats: [Date.now()], pid: process.pid });
    // Now wipe identity.json so the sid is unregistered.
    fs.writeFileSync(path.join(home, '.mycc-store', 'discovery', 'identity.json'), '{}', 'utf-8');
    const { status, stderr, mailboxLines } = run(home);
    expect(status).toBe(1);
    expect(stderr).toMatch(/liveness gate/);
    expect(stderr).toMatch(/not found|unregistered/);
    expect(mailboxLines).toHaveLength(0);
  });

  it('DELIVERS (exit 0) + appends exactly one mail when fresh AND pid alive', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-mail-live-'));
    // process.pid is the vitest worker — guaranteed alive for the test duration.
    fixture(home, { heartbeats: [Date.now()], pid: process.pid });
    const { status, stderr, mailboxLines } = run(home);
    expect(status).toBe(0);
    expect(stderr).not.toMatch(/liveness gate/);
    expect(mailboxLines).toHaveLength(1);
    const mail = JSON.parse(mailboxLines[0]);
    expect(mail.title).toBe('remotes');
    expect(mail.from).toBe('mycc-compose');
    expect(mail.content).toBe('dial http://1.2.3.4:3191'); // round-trips verbatim
  });

  it('WITHOUT --require-online, still appends (warns) even when offline', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-mail-nogate-'));
    fixture(home, { heartbeats: [Date.now() - 200_000], pid: process.pid }); // stale
    // Run WITHOUT --require-online: the legacy non-fatal warning path must
    // still append the mail (the gate is opt-in; existing cron behavior
    // unchanged). This pins that --require-online did not regress the default.
    const env: NodeJS.ProcessEnv = { ...process.env };
    env.USERPROFILE = home;
    env.HOME = home;
    const res = spawnSync(
      process.execPath,
      [MAILER, SID, '--title', 'cron', '--content', 'hello', '--from', 'cron'],
      { encoding: 'utf-8', env, windowsHide: true, timeout: 15_000 },
    );
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/Warning.*offline/);
    expect(run(home).mailboxLines.length).toBeGreaterThanOrEqual(0); // mailbox exists from this run
    const mb = mailboxIn(home);
    const lines = fs.readFileSync(mb, 'utf-8').split('\n').filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).title).toBe('cron');
  });
});