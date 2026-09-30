/**
 * channels.js — channel-file materialization (§5 step 4).
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

/** Substitute {{from}} {{to}} {{peer}} {{label}} in a prompt template. */
export function fillTemplate(tpl, vars) {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
}

/**
 * Append the reciprocal reply contract to a firstQuery, unless the author
 * already wrote a mail_to reply instruction. This is the rule the mediator
 * skill encodes: instances reply peer-to-peer via mail_to, never by prose.
 */
export function withReplyContract(prompt, peerSid, label) {
  if (/mail_to\s*\(/.test(prompt)) return prompt;
  const contract =
    `\n\n[Reply contract] Reply to your peer by calling ` +
    `mail_to(name="${peerSid}/lead", title="${label}:<subject>", content="<message>"). ` +
    `Do NOT reply with prose — only mail_to reaches the peer.`;
  return `${prompt}${contract}`;
}

/**
 * Build the ChannelFile object for one side of a channel pair.
 * Note the ASYMMETRY: each side's `peerSessionId` is the OTHER side's sid.
 *
 * `existing` (the file already on disk, if any) preserves the peer's own
 * lifecycle state across a re-materialize: `joined`/`firstQuerySent` are set by
 * the PEER, not by us. Without this, every cron `sync` reset them to false and
 * the peer re-injected its firstQuery on each run.
 */
export function buildChannelFile({ channelId, ownerSid, peerSid, title, prompt, existing }) {
  return {
    channelId,
    ownerSessionId: ownerSid,
    peerSessionId: peerSid,
    title,
    firstQuery: prompt,
    joined: existing?.joined === true,
    firstQuerySent: existing?.firstQuerySent === true,
    createdAt: existing?.createdAt ?? Date.now(),
  };
}

/**
 * Read an existing channel file, tolerating absence/corruption (a malformed
 * file is treated as absent, matching the peer's own tolerant reader).
 */
export function readChannelFile(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Atomic write of a channel file (tmp + rename), then read-back verify. */
export function writeChannelFileAtomic(file, data) {
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

/**
 * Materialize both files of every channel pair. Resolves each channel endpoint
 * to its peer's session id (via the by-name map built from the spec).
 * Returns a per-channel result list.
 */
export function materializeChannels(spec) {
  const byName = new Map(spec.peers.map((p) => [dupKey(p.name), p]));
  const results = [];

  for (const ch of spec.channels) {
    const fromPeer = byName.get(dupKey(ch.from));
    const toPeer = byName.get(dupKey(ch.to));
    if (!fromPeer || !toPeer) {
      results.push({ label: ch.label, ok: false, reason: 'endpoint-missing' });
      continue;
    }
    if (!fromPeer.sessionId || !toPeer.sessionId) {
      results.push({ label: ch.label, ok: false, reason: 'endpoint-has-no-session' });
      continue;
    }
    const title = `${spec.group}-${ch.label}`;
    const channelId = ch.label;

    // Side A (from) — its peer is `to`.
    const promptA = fillTemplate(ch.prompt, {
      from: fromPeer.name,
      to: toPeer.name,
      peer: toPeer.name,
      label: ch.label,
    });
    const fileA = path.join(CHANNELS_DIR, `${fromPeer.sessionId}-${channelId}.json`);
    writeChannelFileAtomic(
      fileA,
      buildChannelFile({
        channelId,
        ownerSid: fromPeer.sessionId,
        peerSid: toPeer.sessionId,
        title,
        prompt: withReplyContract(promptA, toPeer.sessionId, ch.label),
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
    const fileB = path.join(CHANNELS_DIR, `${toPeer.sessionId}-${channelId}.json`);
    writeChannelFileAtomic(
      fileB,
      buildChannelFile({
        channelId,
        ownerSid: toPeer.sessionId,
        peerSid: fromPeer.sessionId,
        title,
        prompt: withReplyContract(promptB, fromPeer.sessionId, ch.label),
        existing: readChannelFile(fileB),
      }),
    );

    results.push({ label: ch.label, ok: true, title, files: [fileA, fileB] });
  }
  return results;
}

/**
 * Remove exactly the channel files that the spec's channels own.
 *
 * Takes the resolved FILENAME LIST rather than (peers, labels): the previous
 * sid × label cross-product deleted files belonging to peers that were not
 * endpoints of that channel (a foreign session's `<other-sid>-<label>.json`).
 * Only the filenames the materializer would have written are now removed.
 */
export function removeChannels(files) {
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
 * The exact set of channel filenames a spec materializes: for each channel,
 * `<from-sid>-<label>.json` and `<to-sid>-<label>.json`. Peers lacking a
 * session id contribute nothing. This is the ONE definition of "the files this
 * spec owns", shared by materializeChannels/removeChannels/channelStatus so
 * the three can never disagree.
 */
export function channelFileNames(spec) {
  const byName = new Map(spec.peers.map((p) => [dupKey(p.name), p]));
  const names = [];
  for (const ch of spec.channels) {
    const from = byName.get(dupKey(ch.from));
    const to = byName.get(dupKey(ch.to));
    for (const p of [from, to]) {
      if (p && p.sessionId) names.push(`${p.sessionId}-${ch.label}.json`);
    }
  }
  return names;
}

/** Per-channel status row: {label, bothFilesPresent}. */
export function channelStatus(spec) {
  const byName = new Map(spec.peers.map((p) => [dupKey(p.name), p]));
  return spec.channels.map((ch) => {
    const a = byName.get(dupKey(ch.from));
    const b = byName.get(dupKey(ch.to));
    let both = false;
    if (a && b && a.sessionId && b.sessionId && fs.existsSync(CHANNELS_DIR)) {
      const fileA = path.join(CHANNELS_DIR, `${a.sessionId}-${ch.label}.json`);
      const fileB = path.join(CHANNELS_DIR, `${b.sessionId}-${ch.label}.json`);
      both = fs.existsSync(fileA) && fs.existsSync(fileB);
    }
    return { label: ch.label, bothFilesPresent: both };
  });
}
