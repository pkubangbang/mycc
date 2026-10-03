/**
 * mycc-compose-channels.test.ts — unit tests for the channel-file materializer
 * (scripts/mycc-compose/lib/channels.ts), closing review finding C-M3.
 *
 * Every disk write goes to a per-test temp dir via MYCC_DISCOVERY_DIR, which
 * MUST be set before channels.ts is imported: channels.ts captures
 * `CHANNELS_DIR` from lib/discovery.ts at module-load time, so each test
 * re-imports the module after resetModules() (the mycc-compose-peers.test.ts
 * convention).
 *
 * Pinned contracts (each traces to a review finding):
 *   - C-M3 / B-SEC-2: removeChannels(files) takes a FILENAME LIST, not
 *     (peers, labels). The old sid × label cross-product deleted a foreign
 *     peer's `<other-sid>-<label>.json`. The positive-control test asserts the
 *     OWNED file IS deleted first, so "the foreign file survives" cannot pass
 *     by accident when deletion becomes a no-op.
 *   - D-3: buildChannelFile({ existing }) preserves joined/firstQuerySent/
 *     createdAt across a re-materialize (the peer owns that lifecycle state).
 *   - D-6: readChannelFile() is tolerant (absent/corrupt/non-object → null).
 *   - channelFileNames() is the single source of truth for "the files this spec
 *     owns"; sid-less peers contribute nothing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Injection points for the fs.renameSync wrapper (real rename still runs). */
const hook = vi.hoisted(() => ({
  /** Return true to abort a rename with an injected failure (leaves the tmp file). */
  failRename: null as null | ((dst: string) => boolean),
  /** Runs AFTER the real rename — used to corrupt the destination for read-back. */
  afterRename: null as null | ((dst: string) => void),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const renameSync = (...args: Parameters<typeof actual.renameSync>) => {
    const dst = String(args[1]);
    if (hook.failRename?.(dst)) throw new Error('injected rename failure');
    const result = actual.renameSync(...args);
    hook.afterRename?.(dst);
    return result;
  };
  return { ...actual, renameSync, default: { ...actual, renameSync } };
});

const SID_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const SID_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const SID_C = 'cccccccc-3333-4333-8333-333333333333'; // a FOREIGN peer, never in the spec

let tempDir = '';
let channelsDir = '';

function channelsFile(sid: string, label: string): string {
  return path.join(channelsDir, `${sid}-${label}.json`);
}

/** A fresh channels.js bound to the per-test MYCC_DISCOVERY_DIR. */
async function loadChannels() {
  vi.resetModules();
  return import('../../scripts/mycc-compose/lib/channels.js');
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-channels-'));
  channelsDir = path.join(tempDir, 'discovery', 'channels');
  process.env.MYCC_DISCOVERY_DIR = path.join(tempDir, 'discovery');
  hook.failRename = null;
  hook.afterRename = null;
});

afterEach(() => {
  delete process.env.MYCC_DISCOVERY_DIR;
  vi.restoreAllMocks();
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

/** Two peers, one directed channel. */
function spec(): {
  group: string;
  peers: Array<{ name: string; sessionId: string | null }>;
  channels: Array<{ from: string; to: string; label: string; prompt: string }>;
} {
  return {
    group: 'grp',
    peers: [
      { name: 'a', sessionId: SID_A },
      { name: 'b', sessionId: SID_B },
    ],
    channels: [{ from: 'a', to: 'b', label: 'review', prompt: 'Peer is {{to}}.' }],
  };
}

// ---------------------------------------------------------------------------
// fillTemplate
// ---------------------------------------------------------------------------

describe('fillTemplate', () => {
  it('substitutes {{from}} {{to}} {{peer}} {{label}}', async () => {
    const { fillTemplate } = await loadChannels();
    const out = fillTemplate('{{from}} -> {{to}} (peer {{peer}}, label {{label}})', {
      from: 'a',
      to: 'b',
      peer: 'b',
      label: 'review',
    });
    expect(out).toBe('a -> b (peer b, label review)');
  });

  it('tolerates whitespace inside the braces', async () => {
    const { fillTemplate } = await loadChannels();
    expect(fillTemplate('x{{ to }}y', { to: 'b' })).toBe('xby');
  });

  it('leaves an unknown placeholder verbatim', async () => {
    const { fillTemplate } = await loadChannels();
    expect(fillTemplate('keep {{nope}}', { to: 'b' })).toBe('keep {{nope}}');
  });
});

// ---------------------------------------------------------------------------
// withReplyContract
// ---------------------------------------------------------------------------

describe('withReplyContract', () => {
  it('appends the reciprocal contract when the prompt has no mail_to(', async () => {
    const { withReplyContract } = await loadChannels();
    const out = withReplyContract('Do the thing.', SID_B, 'review');
    expect(out.startsWith('Do the thing.')).toBe(true);
    expect(out).toContain(`mail_to(name="${SID_B}/lead"`);
    expect(out).toContain('title="review:<subject>"');
    expect(out).toContain('Do NOT reply with prose');
  });

  it('does not append when the author already wrote a mail_to instruction', async () => {
    const { withReplyContract } = await loadChannels();
    const prompt = `Reply via mail_to(name="{{to}}/lead").`;
    expect(withReplyContract(prompt, SID_B, 'review')).toBe(prompt);
  });
});

// ---------------------------------------------------------------------------
// buildChannelFile — D-3: preserve the peer-owned lifecycle state
// ---------------------------------------------------------------------------

describe('buildChannelFile', () => {
  it('builds a fresh file with false booleans when nothing exists', async () => {
    const { buildChannelFile } = await loadChannels();
    const before = Date.now();
    const built = buildChannelFile({
      channelId: 'review',
      ownerSid: SID_A,
      peerSid: SID_B,
      title: 'grp-review',
      prompt: 'hi',
    });
    expect(built).toMatchObject({
      channelId: 'review',
      ownerSessionId: SID_A,
      peerSessionId: SID_B,
      title: 'grp-review',
      firstQuery: 'hi',
      joined: false,
      firstQuerySent: false,
    });
    expect(built.createdAt).toBeGreaterThanOrEqual(before);
    expect(built.createdAt).toBeLessThanOrEqual(Date.now());
  });

  it('preserves joined/firstQuerySent/createdAt from an existing file (D-3)', async () => {
    const { buildChannelFile } = await loadChannels();
    const existing = { joined: true, firstQuerySent: true, createdAt: 12345 };
    const built = buildChannelFile({
      channelId: 'review',
      ownerSid: SID_A,
      peerSid: SID_B,
      title: 'grp-review',
      prompt: 'hi again',
      existing,
    });
    expect(built.joined).toBe(true);
    expect(built.firstQuerySent).toBe(true);
    expect(built.createdAt).toBe(12345);
    expect(built.firstQuery).toBe('hi again'); // prompt always refreshed
  });

  it('treats a non-true existing value as not-yet-joined', async () => {
    const { buildChannelFile } = await loadChannels();
    const built = buildChannelFile({
      channelId: 'review',
      ownerSid: SID_A,
      peerSid: SID_B,
      title: 't',
      prompt: 'p',
      existing: { joined: 'yes', firstQuerySent: 1, createdAt: 0 },
    });
    expect(built.joined).toBe(false);
    expect(built.firstQuerySent).toBe(false);
    expect(built.createdAt).toBe(0); // 0 is a valid preserved timestamp
  });
});

// ---------------------------------------------------------------------------
// readChannelFile — D-6
// ---------------------------------------------------------------------------

describe('readChannelFile', () => {
  it('returns null for a missing file', async () => {
    const { readChannelFile } = await loadChannels();
    expect(readChannelFile(channelsFile(SID_A, 'nope'))).toBeNull();
  });

  it('returns null for malformed JSON', async () => {
    const { readChannelFile } = await loadChannels();
    fs.mkdirSync(channelsDir, { recursive: true });
    const f = channelsFile(SID_A, 'bad');
    fs.writeFileSync(f, '{ not json');
    expect(readChannelFile(f)).toBeNull();
  });

  it('returns null for a JSON scalar or null (non-object)', async () => {
    const { readChannelFile } = await loadChannels();
    fs.mkdirSync(channelsDir, { recursive: true });
    const scalar = channelsFile(SID_A, 'scalar');
    fs.writeFileSync(scalar, '"just a string"');
    expect(readChannelFile(scalar)).toBeNull();
    const nul = channelsFile(SID_A, 'null');
    fs.writeFileSync(nul, 'null');
    expect(readChannelFile(nul)).toBeNull();
  });

  it('returns the parsed object for a well-formed channel file', async () => {
    const { readChannelFile } = await loadChannels();
    fs.mkdirSync(channelsDir, { recursive: true });
    const f = channelsFile(SID_A, 'ok');
    fs.writeFileSync(f, JSON.stringify({ channelId: 'ok', joined: true }));
    expect(readChannelFile(f)).toMatchObject({ channelId: 'ok', joined: true });
  });
});

// ---------------------------------------------------------------------------
// writeChannelFileAtomic
// ---------------------------------------------------------------------------

describe('writeChannelFileAtomic', () => {
  it('creates the channels dir, writes atomically and leaves no tmp file', async () => {
    const { writeChannelFileAtomic } = await loadChannels();
    const f = channelsFile(SID_A, 'review');
    fs.mkdirSync(path.dirname(channelsDir), { recursive: true }); // discovery/ exists, channels/ does NOT
    const data = { channelId: 'review', ownerSessionId: SID_A, peerSessionId: SID_B };
    writeChannelFileAtomic(f, data);
    expect(fs.existsSync(f)).toBe(true);
    expect(JSON.parse(fs.readFileSync(f, 'utf-8'))).toEqual(data);
    const leftovers = fs.readdirSync(channelsDir).filter((n) => n.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('throws when the read-back peerSessionId does not match', async () => {
    const { writeChannelFileAtomic } = await loadChannels();
    const f = channelsFile(SID_A, 'review');
    hook.afterRename = (dst) => {
      if (dst !== f) return;
      const cur = JSON.parse(fs.readFileSync(f, 'utf-8'));
      cur.peerSessionId = 'tampered'; // simulate a clobbering rename collision
      fs.writeFileSync(f, JSON.stringify(cur));
    };
    expect(() =>
      writeChannelFileAtomic(f, { channelId: 'review', ownerSessionId: SID_A, peerSessionId: SID_B }),
    ).toThrow(/read-back mismatch/);
  });

  it('removes the tmp file when the rename fails', async () => {
    const { writeChannelFileAtomic } = await loadChannels();
    const f = channelsFile(SID_A, 'review');
    hook.failRename = (dst) => dst === f;
    const tmp = `${f}.mycc-compose.${process.pid}.tmp`;
    expect(() =>
      writeChannelFileAtomic(f, { channelId: 'review', ownerSessionId: SID_A, peerSessionId: SID_B }),
    ).toThrow(/injected rename failure/);
    expect(fs.existsSync(tmp)).toBe(false);
    expect(fs.existsSync(f)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// materializeChannels
// ---------------------------------------------------------------------------

describe('materializeChannels', () => {
  it('writes BOTH files of a pair with cross-filled peerSessionId', async () => {
    const { materializeChannels } = await loadChannels();
    const results = materializeChannels(spec());
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ label: 'review', ok: true, title: 'grp-review' });

    const a = JSON.parse(fs.readFileSync(channelsFile(SID_A, 'review'), 'utf-8'));
    const b = JSON.parse(fs.readFileSync(channelsFile(SID_B, 'review'), 'utf-8'));
    // ASYMMETRY: each side points at the OTHER.
    expect(a).toMatchObject({
      channelId: 'review',
      ownerSessionId: SID_A,
      peerSessionId: SID_B,
      title: 'grp-review',
      joined: false,
      firstQuerySent: false,
    });
    expect(b).toMatchObject({ ownerSessionId: SID_B, peerSessionId: SID_A });
  });

  it('fills the template per side (from/to swapped) and appends the contract', async () => {
    const { materializeChannels } = await loadChannels();
    materializeChannels(spec());
    const a = JSON.parse(fs.readFileSync(channelsFile(SID_A, 'review'), 'utf-8'));
    const b = JSON.parse(fs.readFileSync(channelsFile(SID_B, 'review'), 'utf-8'));
    expect(a.firstQuery).toContain('Peer is b.');
    expect(b.firstQuery).toContain('Peer is a.');
    // each side is told to reply to the OTHER sid
    expect(a.firstQuery).toContain(`${SID_B}/lead`);
    expect(b.firstQuery).toContain(`${SID_A}/lead`);
  });

  it('does not append the contract when the prompt already carries mail_to(', async () => {
    const { materializeChannels } = await loadChannels();
    const s = spec();
    s.channels[0].prompt = 'Reply via mail_to(name="{{to}}/lead").';
    materializeChannels(s);
    const a = JSON.parse(fs.readFileSync(channelsFile(SID_A, 'review'), 'utf-8'));
    expect(a.firstQuery).not.toContain('[Reply contract]');
    expect(a.firstQuery).toContain('mail_to(name="b/lead"');
  });

  it('preserves joined across a re-materialize (D-3 cron-sync case)', async () => {
    const { materializeChannels } = await loadChannels();
    materializeChannels(spec());
    const f = channelsFile(SID_A, 'review');
    const joined = JSON.parse(fs.readFileSync(f, 'utf-8'));
    joined.joined = true;
    joined.firstQuerySent = true;
    joined.createdAt = 999;
    fs.writeFileSync(f, JSON.stringify(joined, null, 2));

    materializeChannels(spec()); // a cron `sync` tick

    const after = JSON.parse(fs.readFileSync(f, 'utf-8'));
    expect(after.joined).toBe(true);
    expect(after.firstQuerySent).toBe(true);
    expect(after.createdAt).toBe(999);
  });

  it('reports endpoint-missing and writes nothing', async () => {
    const { materializeChannels } = await loadChannels();
    const s = spec();
    s.channels[0].to = 'ghost';
    const results = materializeChannels(s);
    expect(results).toEqual([{ label: 'review', ok: false, reason: 'endpoint-missing' }]);
    expect(fs.existsSync(channelsFile(SID_A, 'review'))).toBe(false);
    expect(fs.existsSync(channelsFile(SID_B, 'review'))).toBe(false);
  });

  it('reports endpoint-has-no-session for an unminted peer', async () => {
    const { materializeChannels } = await loadChannels();
    const s = spec();
    s.peers[1].sessionId = null;
    const results = materializeChannels(s);
    expect(results).toEqual([{ label: 'review', ok: false, reason: 'endpoint-has-no-session' }]);
    expect(fs.existsSync(channelsFile(SID_A, 'review'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// channelFileNames — the single source of truth for "the files this spec owns"
// ---------------------------------------------------------------------------

describe('channelFileNames', () => {
  it('returns both filenames per channel', async () => {
    const { channelFileNames } = await loadChannels();
    expect(channelFileNames(spec()).sort()).toEqual(
      [`${SID_A}-review.json`, `${SID_B}-review.json`].sort(),
    );
  });

  it('skips a peer with no session id (nothing was materialized for it)', async () => {
    const { channelFileNames } = await loadChannels();
    const s = spec();
    s.peers[1].sessionId = null;
    expect(channelFileNames(s)).toEqual([`${SID_A}-review.json`]);
  });

  it('returns an empty list for a peer-only group', async () => {
    const { channelFileNames } = await loadChannels();
    const s = spec();
    s.channels = [];
    expect(channelFileNames(s)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// removeChannels — B-SEC-2: a FILENAME LIST, never a sid × label cross-product
// ---------------------------------------------------------------------------

describe('removeChannels (filename list, B-SEC-2)', () => {
  /** Materialize the spec, then plant a FOREIGN peer's file with the SAME label. */
  async function plantOwnedAndForeign() {
    const channels = await loadChannels();
    channels.materializeChannels(spec());
    const foreign = channelsFile(SID_C, 'review'); // peer C is NOT in the spec
    fs.writeFileSync(foreign, JSON.stringify({ channelId: 'review', ownerSessionId: SID_C }));
    return { channels, foreign };
  }

  it('deletes the OWNED files (positive control) and spares a foreign peer file', async () => {
    const { channels, foreign } = await plantOwnedAndForeign();
    const owned = channels.channelFileNames(spec());

    const removed = channels.removeChannels(owned);

    // Positive control FIRST: if deletion silently no-ops, this fails here.
    expect(removed).toBe(2);
    expect(fs.existsSync(channelsFile(SID_A, 'review'))).toBe(false);
    expect(fs.existsSync(channelsFile(SID_B, 'review'))).toBe(false);
    // Regression (B-SEC-2): the foreign peer's same-label file must survive.
    expect(fs.existsSync(foreign)).toBe(true);
  });

  it('does not delete a foreign file when only the owned names are passed', async () => {
    const { channels, foreign } = await plantOwnedAndForeign();
    // Exactly what the CLI now does: removeChannels(channelFileNames(spec)).
    channels.removeChannels(channels.channelFileNames(spec()));
    const survivors = fs.readdirSync(channelsDir);
    expect(survivors).toEqual([`${SID_C}-review.json`]);
    expect(JSON.parse(fs.readFileSync(foreign, 'utf-8')).ownerSessionId).toBe(SID_C);
  });

  it('counts only files that existed', async () => {
    const { channels } = await plantOwnedAndForeign();
    channels.removeChannels([`${SID_A}-review.json`]); // delete one
    expect(channels.removeChannels(channels.channelFileNames(spec()))).toBe(1); // only B remains
  });

  it('returns 0 when the channels dir does not exist', async () => {
    const channels = await loadChannels();
    expect(channels.removeChannels([`${SID_A}-review.json`])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// channelStatus
// ---------------------------------------------------------------------------

describe('channelStatus', () => {
  it('reports bothFilesPresent=true once materialized', async () => {
    const { materializeChannels, channelStatus } = await loadChannels();
    materializeChannels(spec());
    expect(channelStatus(spec())).toEqual([{ label: 'review', bothFilesPresent: true }]);
  });

  it('reports false when one side is missing', async () => {
    const { materializeChannels, channelStatus } = await loadChannels();
    materializeChannels(spec());
    fs.rmSync(channelsFile(SID_B, 'review'));
    expect(channelStatus(spec())).toEqual([{ label: 'review', bothFilesPresent: false }]);
  });

  it('reports false for an unminted peer (no file can exist yet)', async () => {
    const { channelStatus } = await loadChannels();
    const s = spec();
    s.peers[1].sessionId = null;
    expect(channelStatus(s)).toEqual([{ label: 'review', bothFilesPresent: false }]);
  });
});
