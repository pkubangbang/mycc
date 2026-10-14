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

/** Case-fold a peer NAME for set membership, matching spec.dupKey's semantics
 * (name uniqueness is enforced case-insensitively at register/validation). */
function normName(s: unknown): string {
  return typeof s === 'string' ? s.trim().normalize('NFC').toLowerCase() : '';
}

/** How a channel file on disk relates to a spec — the attribution verdict. */
export type ChannelFileAttribution =
  /** Carries ownerName/peerName and at least one of them is in the spec's
   * name-set → provably OURS (R1). */
  | { kind: 'by-name'; matchedName: string }
  /** No ownership names (pre-v3 file): ownership can only be judged by the
   * embedded sids, which the caller must test for liveness (R2). */
  | { kind: 'legacy' }
  /** Carries names but NEITHER is in the spec's name-set → provably FOREIGN. */
  | { kind: 'foreign' };

/**
 * Attribute a channel FILE (already parsed) to a spec by NAME.
 *
 * R1 conjunction (Slice 4): a file is OURS-by-name iff its `channelId` is one
 * of the spec's labels AND at least one of its ownership names
 * (`ownerName`/`peerName`) is in the spec's `<group>:<peer>` name-set. The
 * caller enforces the label half; this helper enforces the name half and
 * classifies pre-v3 (nameless) files as `legacy` so the caller can apply the
 * orphan-only sid sweep (R2) instead of trusting the names.
 */
export function attributeChannelFile(
  file: Partial<ChannelFile>,
  nameSet: ReadonlySet<string>,
): ChannelFileAttribution {
  const owner = normName(file.ownerName);
  const peer = normName(file.peerName);
  if (owner === '' && peer === '') return { kind: 'legacy' };
  if (owner !== '' && nameSet.has(owner)) return { kind: 'by-name', matchedName: owner };
  if (peer !== '' && nameSet.has(peer)) return { kind: 'by-name', matchedName: peer };
  return { kind: 'foreign' };
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
 * produced by {@link channelFileNames}). Returns the number removed.
 */
export function removeChannels(files: string[]): number {
  if (!fs.existsSync(CHANNELS_DIR)) return 0;
  let removed = 0;
  for (const name of files) {
    const full = path.join(CHANNELS_DIR, name);
    if (fs.existsSync(full)) {
      fs.rmSync(full);
      removed++;
    }
  }
  return removed;
}

/**
 * The channel filenames a spec OWNS, judged by NAME (R1) with an orphan-only
 * legacy sweep (R2) — the Slice-4 replacement for {@link channelFileNames} in
 * the `down` path. Scans the channels dir and, for every file whose label is
 * one of the spec's labels:
 *
 *   - `by-name` (ownerName/peerName ∈ the spec's name-set) → OURS (R1): delete.
 *   - `legacy` (no ownership names, pre-v3) → OURS only if BOTH embedded sids
 *     are provably DEAD (R2 orphan-only sweep). If either embedded sid is live
 *     the file is NOT deletable evidence — it is kept and reported (ambiguity →
 *     keep; half-matches are investigation material, never deletion evidence).
 *   - `foreign` (names present but none ours) → never ours: kept silently.
 *
 * `isSidDead(sid)` is the LIVENESS predicate injected by the caller — it must
 * be the isPeerRunning-level test (fresh beat AND dead recorded pid), NOT bare
 * heartbeat freshness. Injecting it keeps this module free of resolution, the
 * same boundary `peerSidForFile` respects.
 *
 * Returns the deletable FILENAMES plus the kept-ambiguous filenames (for the
 * operator report). A missing channels dir yields two empty lists.
 */
export function ownedChannelFiles(
  spec: ChannelSpecInput,
  isSidDead: (sid: string) => boolean,
): { deletable: string[]; keptAmbiguous: string[] } {
  const deletable: string[] = [];
  const keptAmbiguous: string[] = [];
  if (!fs.existsSync(CHANNELS_DIR)) return { deletable, keptAmbiguous };

  const labels = new Set(spec.channels.map((ch) => dupKey(ch.label)));
  const nameSet = new Set(spec.peers.map((p) => normName(p.identityName ?? p.name)));

  for (const entry of fs.readdirSync(CHANNELS_DIR)) {
    if (!entry.endsWith('.json') || entry.endsWith('.tmp')) continue;
    // Do NOT parse the label out of the filename: the name is `<sid>-<label>.json`
    // and the sid is a UUID that itself contains dashes, so a naive split is
    // wrong. Read the file and match its `channelId` FIELD (written and
    // read-back-verified by buildChannelFile) against the spec's labels; the
    // filename is used only as the delete token.
    const parsed = readChannelFile(path.join(CHANNELS_DIR, entry));
    if (!parsed) continue; // unreadable → not evidence of ownership → keep
    if (typeof parsed.channelId !== 'string' || !labels.has(dupKey(parsed.channelId))) continue;

    const verdict = attributeChannelFile(parsed, nameSet);
    if (verdict.kind === 'by-name') {
      deletable.push(entry); // R1: provably ours
      continue;
    }
    if (verdict.kind === 'foreign') continue; // provably not ours → keep silently

    // R2 legacy: no names. Delete ONLY when BOTH embedded sids are dead; a live
    // (or unestablished) sid means the file is still claimable → keep + report.
    const sids = [parsed.ownerSessionId, parsed.peerSessionId].filter(
      (s): s is string => typeof s === 'string' && s !== '',
    );
    // Missing/invalid endpoint IDs are uncertainty, not evidence of ownership.
    if (sids.length === 2 && sids.every((sid) => isSidDead(sid))) {
      deletable.push(entry);
    } else {
      keptAmbiguous.push(entry);
    }
  }
  return { deletable, keptAmbiguous };
}

/**
 * The exact set of channel filenames a spec owns: `<sid>-<label>.json` per
 * channel endpoint. Peers without a session id contribute nothing.
 *
 * NOTE (Slice 4): this SID-KEYED enumeration is retained only as a fallback for
 * callers that have NOT yet migrated to name attribution — `down` now uses
 * {@link ownedChannelFiles} (name conjunction + orphan-only legacy sweep).
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

/** Per-channel status row. `attribution` is 'by-name' when at least one of the
 * channel's files was located by its ownership NAMES (R1), or 'legacy' when
 * both were located by the embedded-session-id fallback (pre-v3 files). It is
 * 'absent' when neither file exists. */
export interface ChannelStatusRow {
  label: string;
  bothFilesPresent: boolean;
  attribution: 'by-name' | 'legacy' | 'absent';
}

/**
 * Report whether both files of each channel pair exist, attributing each pair
 * BY NAME where the files carry ownership names, and falling back to the
 * embedded session ids only for pre-v3 (nameless) files.
 *
 * Name attribution is the durable path: a channel file's `ownerName`/
 * `peerName` survive the per-run sid churn, so a pair is "intact" when both
 * endpoint files exist under ANY sid — matched by name. The sid fallback
 * covers files written before names existed (a spec-authoring era), so
 * `status` stays useful against an un-migrated store.
 *
 * DETERMINISM: the result depends only on the spec + the store contents, never
 * on wall-clock — `--json` stays byte-identical across identical invocations.
 */
export function channelStatus(spec: ChannelSpecInput): ChannelStatusRow[] {
  const byName = new Map(spec.peers.map((p) => [dupKey(p.name), p]));
  const nameSet = new Set(spec.peers.map((p) => normName(p.identityName ?? p.name)));
  // Index every channel file in the store ONCE by its parsed `channelId` FIELD
  // (the filename is `<sid>-<label>.json` where the sid's own dashes make a
  // filename-derived label unreliable). Name-attributed lookup then does not
  // depend on any sid.
  const byLabel = new Map<string, Array<{ file: string; data: ChannelFile }>>();
  if (fs.existsSync(CHANNELS_DIR)) {
    for (const entry of fs.readdirSync(CHANNELS_DIR)) {
      if (!entry.endsWith('.json') || entry.endsWith('.tmp')) continue;
      const data = readChannelFile(path.join(CHANNELS_DIR, entry));
      if (!data || typeof data.channelId !== 'string') continue;
      const label = dupKey(data.channelId);
      const list = byLabel.get(label) ?? [];
      list.push({ file: entry, data });
      byLabel.set(label, list);
    }
  }

  return spec.channels.map((ch) => {
    const label = dupKey(ch.label);
    const a = byName.get(dupKey(ch.from));
    const b = byName.get(dupKey(ch.to));
    const candidates = byLabel.get(label) ?? [];

    // SID fallback for pre-v3 files (no names): a pair is intact when the two
    // endpoint files exist under the peers' resolved sids.
    let bothBySid = false;
    if (a && b) {
      const aSid = peerSidForFile(a);
      const bSid = peerSidForFile(b);
      if (aSid && bSid) {
        const fileA = `${aSid}-${ch.label}.json`;
        const fileB = `${bSid}-${ch.label}.json`;
        bothBySid = candidates.some((c) => c.file === fileA) && candidates.some((c) => c.file === fileB);
      }
    }

    // NAME attribution (R1): a file is ours-by-name when at least one of its
    // ownership names is in the spec's name-set. A pair is intact when both
    // endpoints (from-name and to-name) are present across the label's files.
    let bothByName = false;
    if (a && b) {
      const fromName = normName(a.identityName ?? a.name);
      const toName = normName(b.identityName ?? b.name);
      const named = candidates
        .map((c) => attributeChannelFile(c.data, nameSet))
        .filter((v): v is { kind: 'by-name'; matchedName: string } => v.kind === 'by-name');
      const seen = new Set(named.map((v) => v.matchedName));
      bothByName = fromName !== '' && toName !== '' && seen.has(fromName) && seen.has(toName);
    }

    const attribution: ChannelStatusRow['attribution'] = bothByName
      ? 'by-name'
      : bothBySid
        ? 'legacy'
        : 'absent';
    return { label: ch.label, bothFilesPresent: bothByName || bothBySid, attribution };
  });
}