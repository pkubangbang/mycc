/**
 * mycc-compose-status.test.ts — `status --json` must be DETERMINISTIC, and the
 * channel rows must carry the 3-way attribution verdict (by-name / legacy /
 * absent) added in Slice 4 (R1 name attribution + R2 legacy sid fallback).
 *
 * The command and docs/peers/peer-topology.md both call the JSON report
 * deterministic: two identical invocations against the same on-disk state must
 * produce byte-identical JSON. A wall-clock `generatedAt` field broke that (two
 * runs a millisecond apart differ). This suite pins the fix: the
 * machine-readable report carries NO timestamp, and two consecutive runs are
 * byte-identical; the human-readable form may still print a timestamp.
 *
 * Attribution (Slice 4 / M7): each channel row is
 *   { label, bothFilesPresent, attribution }
 * where `attribution` is 'by-name' when both endpoint files were located by
 * their DATA-ONLY ownership names, 'legacy' when located purely by the
 * pre-v3 embedded session ids, and 'absent' when at least one side is missing.
 * The three verdicts are pinned with one fixture each.
 *
 * Seams: cmd-status reads the spec file (validateSpec(loadSpec(file))) and the
 * discovery store, so we write a real spec into a temp dir and point
 * MYCC_DISCOVERY_DIR at a per-test temp store. process.exit and
 * process.stdout.write are stubbed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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

describe('cmdStatus --json: channel attribution 3-way (Slice 4 / M7)', () => {
  it("'by-name': both endpoint files carry the spec's ownership names", async () => {
    plantChannel(SID_A, 'review', {
      channelId: 'review', ownerSessionId: SID_A, peerSessionId: SID_B,
      ownerName: 'g:p1', peerName: 'g:p2',
    });
    plantChannel(SID_B, 'review', {
      channelId: 'review', ownerSessionId: SID_B, peerSessionId: SID_A,
      ownerName: 'g:p2', peerName: 'g:p1',
    });
    const { parsed } = await runJson();
    expect(parsed.channels).toEqual([
      { label: 'review', bothFilesPresent: true, attribution: 'by-name' },
    ]);
  });

  it("'legacy': pre-v3 files (no names) located purely by embedded sid", async () => {
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
      { label: 'review', bothFilesPresent: true, attribution: 'legacy' },
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
