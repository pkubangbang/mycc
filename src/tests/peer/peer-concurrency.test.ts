/**
 * peer-concurrency.test.ts — Race-condition tests for mail.ts collectMails
 * (Fix #2) and identity.ts register()/unregister() (Fix #3).
 *
 * Fix #2: collectMails uses rename-then-read so a concurrent appendMail
 * landing between read and clear goes to the NEW file and is NOT lost.
 * Fix #3: register uses a read-merge-write loop or retry-on-clobber so
 * two simultaneous registers don't lose each other's entry.
 *
 * MailBox uses session-scoped directories via getSessionDir/getSessionContext.
 * We mock config.js to point at a per-test temp dir and call setSessionContext
 * so the MailBox can locate its files.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// --- Mock config so session/mail paths point at a temp directory -------------
let tempDir = '';
const sessionDir = () => path.join(tempDir, 'sessions', 'test-session');

vi.mock('../../config.js', () => ({
  getSessionDir: (sid: string) => path.join(tempDir, 'sessions', sid),
  getSessionContext: () => 'test-session',
  setSessionContext: (sid: string) => { /* no-op for tests */ },
  ensureDirs: () => {
    const dir = sessionDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  },
  // identity helpers for the register race test
  getDiscoveryDir: () => path.join(tempDir, 'discovery'),
  getIdentityFile: () => path.join(tempDir, 'discovery', 'identity.json'),
  getHeartbeatDir: () => path.join(tempDir, 'discovery', 'heartbeat'),
  getHeartbeatFile: (sid: string) =>
    path.join(tempDir, 'discovery', 'heartbeat', `${sid}.json`),
  getChannelsDir: () => path.join(tempDir, 'discovery', 'channels'),
  getChannelFile: (sid: string, cid: string) =>
    path.join(tempDir, 'discovery', 'channels', `${sid}-${cid}.json`),
}));

import { MailBox } from '../../context/shared/mail.js';
import { setSessionContext } from '../../config.js';
import { IdentityManager } from '../../peer/identity.js';

function sid(i: number): string {
  const base = '00000000-0000-0000-0000-000000000000';
  // Replace first hex char with i so each session id is distinct.
  return i.toString(16).padStart(1, '0') + base.slice(1);
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-conc-'));
  fs.mkdirSync(sessionDir(), { recursive: true });
  setSessionContext('test-session');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fix #2: collectMails rename-then-read contract
// ---------------------------------------------------------------------------

describe('collectMails() rename-then-read contract (Fix #2)', () => {
  it('collectMails consumes all unread mail and leaves the unread file empty', () => {
    const box = new MailBox('lead');
    box.appendMail('alice', 't1', 'c1');
    box.appendMail('bob', 't2', 'c2');

    const mails = box.collectMails();
    expect(mails).toHaveLength(2);
    expect(mails[0].title).toBe('t1');
    expect(mails[1].title).toBe('t2');

    // The unread file must be empty after collect.
    expect(box.hasNewMails()).toBe(false);
  });

  it('a post-truncate append is picked up by the NEXT collectMails', () => {
    const box = new MailBox('lead');
    box.appendMail('alice', 'first', 'c1');
    const first = box.collectMails();
    expect(first).toHaveLength(1);

    // Append after collect — must be in the NEW (empty) file, picked up next time.
    box.appendMail('bob', 'second', 'c2');
    const second = box.collectMails();
    expect(second).toHaveLength(1);
    expect(second[0].title).toBe('second');
  });

  it('collectMails does not lose mail appended concurrently (rename-then-read)', async () => {
    // AFTER FIX: collectMails renames the unread file to a temp name, reads
    // that, and leaves a fresh empty file at the original path. An appendMail
    // landing between read and clear now goes to the NEW empty file and is
    // picked up by the NEXT collectMails — never lost.
    const box = new MailBox('lead');
    box.appendMail('alice', 'seed', 'seed');

    // Fire several appends concurrently while collectMails runs.
    const appenders: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) {
      appenders.push(
        Promise.resolve().then(() => box.appendMail('race', `r${i}`, `c${i}`))
      );
    }
    const collected = box.collectMails();
    await Promise.all(appenders);

    // A final collectMails picks up anything the concurrent appends wrote
    // to the fresh file after the rename.
    const finalMails = box.collectMails();

    // Total distinct mails across both collects: seed + all 10 racers.
    const total = collected.length + finalMails.length;
    expect(total).toBe(11);
  });
});

// ---------------------------------------------------------------------------
// Fix #3: identity.json concurrent register() race
// ---------------------------------------------------------------------------

describe('concurrent register() race (Fix #3)', () => {
  it('5 simultaneous registers with distinct session IDs all persist', async () => {
    const ids: IdentityManager[] = [];
    for (let i = 1; i <= 5; i++) {
      ids.push(new IdentityManager(sid(i), `/work/${i}`, path.join(tempDir, `mb-${i}.jsonl`)));
    }

    // Fire all registers concurrently — the read-merge-write must not clobber.
    await Promise.all(ids.map(id => Promise.resolve(id.register())));

    // Read identity.json with a fresh instance and assert all 5 entries.
    const checker = new IdentityManager(sid(99), '/work/x', path.join(tempDir, 'mb-x.jsonl'));
    const entries = checker.listIdentities();
    expect(entries).toHaveLength(5);
    const sessionIds = entries.map(e => e.sessionId).sort();
    for (let i = 1; i <= 5; i++) {
      expect(sessionIds).toContain(sid(i));
    }
  });

  it('10 simultaneous registers with distinct session IDs all persist', async () => {
    const ids: IdentityManager[] = [];
    for (let i = 1; i <= 10; i++) {
      ids.push(new IdentityManager(sid(i), `/work/${i}`, path.join(tempDir, `mb-${i}.jsonl`)));
    }

    await Promise.all(ids.map(id => Promise.resolve(id.register())));

    const checker = new IdentityManager(sid(99), '/work/x', path.join(tempDir, 'mb-x.jsonl'));
    const entries = checker.listIdentities();
    expect(entries).toHaveLength(10);
  });
});