/**
 * channels.ts — channel-file materialization (§5 step 4).
 *
 * A "channel pair" is two ChannelFile JSON documents (one per side) written to
 * ~/.mycc-store/discovery/channels/<sid>-<label>.json, cross-referencing each
 * other's session id. The peers' own poll picks these up and turns them into
 * mail channels. Writes are atomic (tmp + rename) and read-back verified.
 */

import fs from 'fs';
import path from 'path';
import { CHANNELS_DIR } from './discovery.js';
import { dupKey } from './spec.js';
import type { ChannelFile } from '../../../src/types.js';

/**
 * The narrow STRUCTURAL subset of a spec that the materializer actually reads.
 * Declared separately from NormalizedSpec because the module's real input
 * contract is what matters here: it reads peers[].name to resolve channel
 * references and peers[].identityName for durable ownership metadata. It also
 * reads channels[].from/.to/.label/.prompt. A NormalizedSpec (with workdir/args/
 * renew/parsedArgs) is assignable to this.
 *
 * The peer session id is DELIBERATELY ABSENT: a spec no longer authors one
 * (peers[].sessionId is rejected at validation), and the runtime sid is minted
 * by the peer itself per boot and resolved from identity.json by peer NAME.
 * Since Slice 3, callers (cmd-up/cmd-down) resolve each peer's sid by name
 * BEFORE calling this module, so `peerSidForFile` merely READS the
 * already-resolved sid carried on the peer — the resolution seam lives ABOVE
 * (a spec never carries a sid, and this module never resolves one itself).
 */
export interface ChannelSpecInput {
  group: string;
  peers: Array<{ name: string; identityName?: string }>;
  channels: Array<{ from: string; to: string; label: string; prompt: string }>;
}

/** Substitute {{from}} {{to}} {{peer}} {{label}} in a prompt template. */
export function fillTemplate(tpl: string, vars: Record<string, unknown>): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
}

/**
 * The runtime session id carried on a peer record, read STRUCTURALLY.
 *
 * Callers (cmd-up/cmd-down) resolve the sid by durable NAME before invoking the
 * materializer, stamping it onto the peer; this accessor only READS that
 * already-resolved value. `ChannelSpecInput.peers[]` deliberately does NOT
 * declare `sessionId` (a spec never authors one), so a `NormalizedSpec` peer
 * carries it structurally via its index signature. Returns null when the sid is
 * not a non-empty string (→ the caller reports endpoint-has-no-session).
 */
function peerSidForFile(peer: { name: string; [key: string]: unknown }): string | null {
  const sid = peer.sessionId;
  return typeof sid === 'string' && sid !== '' ? sid : null;
}

/** The durable `<group>:<peer>` NAME of a peer record, read STRUCTURALLY
 * (mirrors {@link peerSidForFile}). Written into the channel file as a
 * DATA-ONLY ownership field (`ownerName`/`peerName`) so compose can attribute a
 * channel to a topology peer by NAME — stable across the per-run sid churn —
 * for stale-file cleanup (Slice 4). Null when absent. */
function peerNameForFile(peer: { name: string; identityName?: string; [key: string]: unknown }): string | null {
  const name = peer.identityName ?? peer.name;
  return typeof name === 'string' && name !== '' ? name : null;
}

/**
 * Append the reciprocal reply contract to a firstQuery, unless the author
 * already wrote a mail_to reply instruction. This is the rule the mediator
 * skill encodes: instances reply peer-to-peer via mail_to, never by prose.
 */
export function withReplyContract(prompt: string, peerSid: string, label: string): string {
  if (/mail_to\s*\(/.test(prompt)) return prompt;
  const contract =
    `\n\n[Reply contract] Reply to your peer by calling ` +
    `mail_to(name="${peerSid}/lead", title="${label}:<subject>", content="<message>"). ` +
    `Do NOT reply with prose — only mail_to reaches the peer.`;
  return `${prompt}${contract}`;
}

/** Fields the peer may already have written back onto its own channel file. */
export interface ExistingChannelState {
  joined?: unknown;
  firstQuerySent?: unknown;
  createdAt?: unknown;
}

/** Arguments for {@link buildChannelFile}. */
export interface BuildChannelFileArgs {
  channelId: string;
  ownerSid: string;
  peerSid: string;
  /** Durable `<group>:<peer>` NAME of the OWNER side (data-only, R1). */
  ownerName?: string | null;
  /** Durable `<group>:<peer>` NAME of the OTHER side (data-only, R1). */
  peerName?: string | null;
  title: string;
  prompt: string;
  /** The file already on disk, if any — preserves joined/firstQuerySent/createdAt. */
  existing?: ExistingChannelState | null;
}

/**
 * Build the ChannelFile document for ONE side of a pair. `peerSid` is the
 * OTHER side's session id (the pair is asymmetric by design). `ownerName` /
 * `peerName` are DATA-ONLY ownership names (the durable `<group>:<peer>` handle)
 * written so compose can later attribute a file to a topology peer by NAME,
 * which survives the per-run sid churn.
 */
export function buildChannelFile(args: BuildChannelFileArgs): ChannelFile {
  const { channelId, ownerSid, peerSid, ownerName, peerName, title, prompt, existing } = args;
  return {
    channelId,
    ownerSessionId: ownerSid,
    peerSessionId: peerSid,
    ...(ownerName ? { ownerName } : {}),
    ...(peerName ? { peerName } : {}),
    title,
    firstQuery: prompt,
    joined: existing?.joined === true,
    firstQuerySent: existing?.firstQuerySent === true,
    createdAt: typeof existing?.createdAt === 'number' ? existing.createdAt : Date.now(),
  };
}

/** Read an existing channel file; null when absent / malformed / non-object. */
export function readChannelFile(file: string): ChannelFile | null {
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Atomic write (tmp + rename) with a read-back verify of channelId/ownerSessionId/peerSessionId. */
export function writeChannelFileAtomic(
  file: string,
  data: Partial<ChannelFile> & Pick<ChannelFile, 'channelId' | 'ownerSessionId' | 'peerSessionId'>,
): void {
  if (!fs.existsSync(CHANNELS_DIR)) fs.mkdirSync(CHANNELS_DIR, { recursive: true });
  const tmp = `${file}.mycc-compose.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
    // Read-back: guarantee the peers' poll sees a well-formed file. Verify
    // peerSessionId too — a rename over an existing file replaces it silently
    // on Windows, so channelId/ownerSessionId alone could not catch a collision
    // that clobbered the cross-reference.
    const back = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (back.channelId !== data.channelId ||
        back.ownerSessionId !== data.ownerSessionId ||
        back.peerSessionId !== data.peerSessionId) {
      throw new Error(`channel read-back mismatch after writing ${file}`);
    }
  } catch (err) {
    // Do not leak a half-written tmp file behind us on failure.
    try {
      if (fs.existsSync(tmp)) fs.rmSync(tmp);
    } catch {
      // best effort
    }
    throw err;
  }
}

/** Per-channel materialization result. */
export interface MaterializeResult {
  label: string;
  ok: boolean;
  reason?: string;
  title?: string;
  files?: string[];
}

/** Write both files of every channel pair. */
export function materializeChannels(spec: ChannelSpecInput): MaterializeResult[] {
  const byName = new Map(spec.peers.map((p) => [dupKey(p.name), p]));
  const results: MaterializeResult[] = [];

  for (const ch of spec.channels) {
    const fromPeer = byName.get(dupKey(ch.from));
    const toPeer = byName.get(dupKey(ch.to));
    if (!fromPeer || !toPeer) {
      results.push({ label: ch.label, ok: false, reason: 'endpoint-missing' });
      continue;
    }
    const fromSid = peerSidForFile(fromPeer);
    const toSid = peerSidForFile(toPeer);
    if (!fromSid || !toSid) {
      results.push({ label: ch.label, ok: false, reason: 'endpoint-has-no-session' });
      continue;
    }
    const fromName = peerNameForFile(fromPeer);
    const toName = peerNameForFile(toPeer);
    const title = `${spec.group}-${ch.label}`;
    const channelId = ch.label;

    // Side A (from) — its peer is `to`.
    const promptA = fillTemplate(ch.prompt, {
      from: fromPeer.name,
      to: toPeer.name,
      peer: toPeer.name,
      label: ch.label,
    });
    const fileA = path.join(CHANNELS_DIR, `${fromSid}-${channelId}.json`);
    writeChannelFileAtomic(
      fileA,
      buildChannelFile({
        channelId,
        ownerSid: fromSid,
        peerSid: toSid,
        ownerName: fromName,
        peerName: toName,
        title,
        prompt: withReplyContract(promptA, toSid, ch.label),
        existing: readChannelFile(fileA),
      }),
    );

    // Side B (to) — its peer is `from`.
    const promptB = fillTemplate(ch.prompt, {
      from: toPeer.name,
      to: fromPeer.name,
      peer: fromPeer.name,
      label: ch.label,
    });
    const fileB = path.join(CHANNELS_DIR, `${toSid}-${channelId}.json`);
    writeChannelFileAtomic(
      fileB,
      buildChannelFile({
        channelId,
        ownerSid: toSid,
        peerSid: fromSid,
        ownerName: toName,
        peerName: fromName,
        title,
        prompt: withReplyContract(promptB, fromSid, ch.label),
        existing: readChannelFile(fileB),
      }),
    );

    results.push({ label: ch.label, ok: true, title, files: [fileA, fileB] });
  }
  return results;
}

/**
 * Remove exactly the channel files named in `files` (a FILENAME LIST, as
 * produced by {@link channelFileNames}). BEST-EFFORT by contract: an unlink that
 * fails (a peer still holding the handle on Windows, a permissions error) is
 * collected and reported by the caller, never thrown — the peers are already
 * stopped when this runs, so a stubborn file must not abort the teardown or
 * change its exit code.
 *
 * Returns the number removed plus the filenames that could not be removed.
 */
export function removeChannels(files: string[]): { removed: number; failed: string[] } {
  if (!fs.existsSync(CHANNELS_DIR)) return { removed: 0, failed: [] };
  let removed = 0;
  const failed: string[] = [];
  for (const name of files) {
    const full = path.join(CHANNELS_DIR, name);
    if (!fs.existsSync(full)) continue;
    try {
      fs.rmSync(full);
      removed++;
    } catch {
      failed.push(name);
    }
  }
  return { removed, failed };
}

/**
 * The exact set of channel filenames a spec owns: `<sid>-<label>.json` per
 * channel endpoint. Peers without a RESOLVED session id contribute nothing —
 * the caller (cmd-down) resolves each peer's sid from identity.json by NAME
 * BEFORE calling this, which is the whole ownership model: the sid is unique per
 * run, so the filename alone identifies the file. The file's CONTENT
 * (ownerName/peerName/channelId) is never consulted — names are persistent and
 * can coincide across two specs that share a group name, which is exactly how
 * the old content-based "either name matches" rule deleted another topology's
 * file (audit finding AC-5).
 */
export function channelFileNames(spec: ChannelSpecInput): string[] {
  const byName = new Map(spec.peers.map((p) => [dupKey(p.name), p]));
  const names: string[] = [];
  for (const ch of spec.channels) {
    const from = byName.get(dupKey(ch.from));
    const to = byName.get(dupKey(ch.to));
    for (const p of [from, to]) {
      if (!p) continue;
      const sid = peerSidForFile(p);
      if (sid) names.push(`${sid}-${ch.label}.json`);
    }
  }
  return names;
}

/** Per-channel status row. `attribution` is 'present' when BOTH endpoint files
 * `<sid>-<label>.json` exist for the peers' resolved sids, 'absent' otherwise
 * (see {@link channelStatus}). */
export interface ChannelStatusRow {
  label: string;
  bothFilesPresent: boolean;
  attribution: 'present' | 'absent';
}

/**
 * Report whether both files of each channel pair exist, located by NAME → SID →
 * FILENAME: the caller (cmd-status) resolves each peer's live sid from
 * identity.json by durable NAME before calling this, so each endpoint's file is
 * exactly `<sid>-<label>.json`.
 *
 * This mirrors the DELETION rule in {@link channelFileNames} — the same
 * filename-based ownership model, never the file's CONTENT. The earlier
 * content-based name attribution reported "both files present" from a sibling
 * topology's file (persistent names can coincide across specs sharing a group
 * name), and from a stale-generation file left behind by a previous run
 * (audit finding AC-1).
 *
 * DETERMINISM: the result depends only on the spec + the resolved sids, never
 * on wall-clock — `--json` stays byte-identical across identical invocations.
 */
export function channelStatus(spec: ChannelSpecInput): ChannelStatusRow[] {
  const byName = new Map(spec.peers.map((p) => [dupKey(p.name), p]));
  return spec.channels.map((ch) => {
    const a = byName.get(dupKey(ch.from));
    const b = byName.get(dupKey(ch.to));
    const sids: string[] = [];
    for (const p of [a, b]) {
      const sid = p ? peerSidForFile(p) : null;
      if (sid) sids.push(sid);
    }
    // Both endpoints must be RESOLVED and their exact files present; an
    // unresolved endpoint is 'absent', never guessed from another sid's file.
    const present = sids.length === 2 &&
      sids.every((sid) => fs.existsSync(path.join(CHANNELS_DIR, `${sid}-${ch.label}.json`)));
    return { label: ch.label, bothFilesPresent: present, attribution: present ? 'present' : 'absent' };
  });
}
