/**
 * mail-identity.ts - Classify a mail sender address (`Mail.from`) for routing.
 *
 * One place decides "what kind of sender is this, and can we mail it back?".
 * Before this module the answer was spelled inline in two places as
 * `mail.from.endsWith('/lead')` (COLLECT in src/loop/states/collect.ts and the
 * child loop in src/context/teammate-worker.ts), which cannot express a
 * sender that is deliberately NOT routable.
 *
 * Sender shapes (a/b[/c]) — the SLASH COUNT is the discriminator, and it must
 * stay that way: the peer route in mail_to.ts is the only one with `/lead`
 * appended, while external senders never carry an agent segment.
 *
 *   1. "lead"                          — local IPC sentinel (lead ↔ teammate).
 *   2. "<teammate-name>"               — a teammate of this instance (no "/").
 *   3. "<uuid>/lead"                   — cross-instance peer (local discovery or
 *                                        remote wire). This session-id IS the
 *                                        mail_to `name` argument → routable.
 *   4. "<app>/<group>/<id>"            — EXTERNAL three-part address (e.g.
 *                                        "myview/REDBOX/56232"): an application
 *                                        that pushed mail into our mailbox. The
 *                                        first part is the app name. It is
 *                                        NON-ROUTABLE: it is not a mycc session
 *                                        and has no mailbox we can write, so
 *                                        mail_to must refuse it instead of
 *                                        pretending to deliver a reply.
 *   5. anything else                   — unknown. Never routable.
 *
 * Note on why `endsWith("/lead")` alone is NOT enough to call something a peer:
 * an external app could in principle name its sender "myview/REDBOX/lead".
 * Classification therefore checks the THREE-part shape FIRST, so such an
 * address is still external (non-routable) rather than being mistaken for a
 * peer identity.
 */

/** What a mail sender address is. */
export type SenderKind =
  /** The local "lead" IPC sentinel. Routable. */
  | 'lead'
  /** A teammate in this instance's roster (bare name, no "/"). Routable. */
  | 'teammate'
  /** Cross-instance peer "<uuid>/lead" — local discovery or remote wire. Routable. */
  | 'peer'
  /** External app address "<app>/<group>/<id>" (or any 3+-part address). NON-ROUTABLE. */
  | 'external'
  /** Not any recognized shape (e.g. "system", "filesync", "a/lead"). NON-ROUTABLE. */
  | 'unknown';

export interface SenderInfo {
  kind: SenderKind;
  /** True when mail_to can deliver to this address. */
  routable: boolean;
  /** Present only for kind === 'peer' — the peer's session-id (the mail_to name). */
  sessionId?: string;
  /** Present only for kind === 'external' — the leading app name. */
  app?: string;
  /** Present only for kind === 'external' — app/group/id segments, in order. */
  segments?: string[];
}

/** UUID format: 8-4-4-4-12 hex (case-insensitive) — a mycc session id. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Number of slash-separated segments that make an address "external". */
const EXTERNAL_MIN_SEGMENTS = 3;

/**
 * A segment of an external address: a non-empty token with no whitespace and
 * no further slashes. Deliberately permissive on characters (an app name may be
 * "myview", an id may be "56232"), strict on structure.
 */
const SEGMENT_RE = /^[^\s/]+$/;

/** Is `address` a well-formed external sender, and if so what are its parts? */
export function parseExternalAddress(address: string): { app: string; segments: string[] } | null {
  if (typeof address !== 'string') return null;
  const segments = address.split('/');
  if (segments.length < EXTERNAL_MIN_SEGMENTS) return null;
  if (!segments.every((s) => SEGMENT_RE.test(s))) return null;
  return { app: segments[0], segments };
}

/**
 * Classify a mail sender address. Pure: no filesystem, no context, no I/O.
 */
export function classifySender(address: string): SenderInfo {
  const from = typeof address === 'string' ? address.trim() : '';
  if (!from) return { kind: 'unknown', routable: false };

  // 4. External first — a three-part address is external even when its last
  //    segment happens to read "lead" (see the note in the module header).
  const external = parseExternalAddress(from);
  if (external) {
    return { kind: 'external', routable: false, app: external.app, segments: external.segments };
  }

  const slashIdx = from.indexOf('/');
  if (slashIdx <= 0) {
    // 1./2. No "/" at all: the lead sentinel or a bare teammate name.
    if (from === 'lead') return { kind: 'lead', routable: true };
    return { kind: 'teammate', routable: true };
  }

  // 3. "<uuid>/lead" — the one (and only) peer route. Two segments with a
  //    UUID session part; any other two-part name is not a mycc identity
  //    (the caller may still resolve it as a teammate when the roster is
  //    known — see isNonRoutableSender's `roster` parameter).
  const sessionId = from.slice(0, slashIdx);
  const agent = from.slice(slashIdx + 1);
  if (agent === 'lead' && UUID_RE.test(sessionId)) {
    return { kind: 'peer', routable: true, sessionId };
  }

  return { kind: 'unknown', routable: false };
}

/**
 * True when mail_to must REFUSE this address instead of attempting delivery.
 *
 * `roster` is optional and only relevant for two-part names: a teammate name
 * cannot contain "/", so a two-part non-UUID name ("review-peer-1/lead") is
 * never a roster member — passing the roster therefore does not change the
 * answer today, but keeps the decision in one place if naming rules relax.
 */
export function isNonRoutableSender(address: string, roster?: readonly string[]): boolean {
  const info = classifySender(address);
  if (info.kind === 'external' || info.kind === 'unknown') return true;
  if (info.kind === 'teammate' && roster && !roster.includes(address.trim())) return true;
  return false;
}

/**
 * Human-readable description of a sender for a MAIL note header, e.g.
 * " (peer — cross-instance)" or " (external app myview — no reply address)".
 * `lead`/teammate return '' so ordinary local mail stays untagged.
 */
export function describeSender(address: string): string {
  const info = classifySender(address);
  switch (info.kind) {
    case 'peer':
      return ' (peer — cross-instance)';
    case 'external':
      return ` (external app ${info.app} — NO reply address: this mail is one-way, do not try to mail it back)`;
    case 'unknown':
      return ' (unknown sender — no reply address: do not try to mail it back)';
    default:
      return '';
  }
}

/**
 * The reply line appended to a collected mail, or null when the sender cannot
 * be mailed back. Callers append `↳ ...` instructions only for a non-null
 * value, so a one-way external sender never gets a bogus reply recipe.
 */
export function replyHint(address: string, title: string): string | null {
  const info = classifySender(address);
  if (info.kind === 'external') {
    return (
      `↳ NO REPLY: '${address}' is an external sender (app "${info.app}") with no mailbox mycc can write to. ` +
      `This message is one-way — do not call mail_to for it, and do not invent a delivery step. ` +
      `If the sender needs an answer, tell the user / report it instead.`
    );
  }
  if (info.kind === 'unknown') {
    return (
      `↳ NO REPLY: '${address}' is not a routable recipient (not "lead", a teammate, or "<session-id>/lead"). ` +
      `Do not call mail_to for it.`
    );
  }
  const peerNote = info.kind === 'peer' ? ' — for a peer this session-id IS the name argument.' : '';
  return `↳ Reply with mail_to(name="${address}", title="${title}: <re>", content="…")${peerNote}`;
}

/**
 * Describe why a recipient address cannot be mailed, for mail_to's error text.
 * Returns null when the address IS routable.
 */
export function explainNonRoutable(address: string): string | null {
  const info = classifySender(address);
  if (info.kind === 'external') {
    return (
      `'${address}' is an EXTERNAL sender address (app "${info.app}") — it is not a mycc session and has no ` +
      `mailbox we can write to, so mail cannot be sent back to it. External mail is one-way.`
    );
  }
  if (info.kind === 'unknown') {
    return (
      `'${address}' is not a routable recipient. A routable name is "lead", a live teammate name (no "/"), ` +
      `or a peer "<session-id>/lead" with the session-id as a UUID.`
    );
  }
  return null;
}
