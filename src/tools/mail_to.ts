/**
 * mail_to.ts - Send async message to a specific teammate
 *
 * Scope: ['main', 'child'] - Both lead and teammates can send mail
 *
 * When a child process sends mail to 'lead' with eta>0 (seconds from now),
 * the handler passes eta to ctx.team.mailTo(), which is handled by ChildTeam
 * to send IPC 'eta_update' to the parent so TeamManager tracks the deadline.
 */

import chalk from 'chalk';
import type { ToolDefinition, AgentContext } from '../types.js';
import { explainNonRoutable, parseExternalAddress } from '../peer/mail-identity.js';

export const mailToTool: ToolDefinition = {
  name: 'mail_to',
  description:
    'Send an async message to a teammate or "lead". Non-blocking. Use for task assignment and inter-agent communication; include meaningful content.',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description:
          'Target recipient: a teammate name, "lead" for local IPC, or a cross-instance peer identity "<session-id>/lead" to route to a remote mycc instance. ' +
          'External three-part senders ("<app>/<group>/<id>", e.g. "myview/REDBOX/56232") are one-way and NOT routable — never a valid recipient.'
      },
      title: {
        type: 'string',
        description: 'Message title/subject'
      },
      content: {
        type: 'string',
        description: 'Message body content'
      },
      eta: {
        type: 'number',
        description:
          'MANDATORY when a teammate first mails "lead" (or extends). Duration in seconds (eta=120 = about 2 minutes); converted to an absolute deadline. ' +
          'Set to 0 or omit for non-budget messages (progress updates, lead responses).'
      }
    },
    required: ['name', 'title', 'content']
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    let name = args.name as string;
    const title = args.title as string;
    const content = args.content as string;
    const eta = args.eta as number | undefined;

    // An external app address ("<app>/<group>/<id>") is a SENDER format only.
    // If it shows up as a recipient, name the reason instead of the generic
    // "unrecognized recipient" text — the two-part error is about peer routes.
    if (typeof name === 'string') {
      const ext = parseExternalAddress(name.trim());
      if (ext) {
        ctx.core.brief(
          'error',
          'mail_to',
          `External sender '${name}' is non-routable (app "${ext.app}") — mail cannot be sent back.`
        );
        return (
          `Error: '${name}' is an EXTERNAL sender address, not a recipient. It is a ${ext.segments.length}-part ` +
          `"<app>/<group>/<id>" address pushed by an external application; such senders have no mailbox mycc can ` +
          `write to, so their mail is one-way and cannot be answered with mail_to. ` +
          `Routable names are "lead", a live teammate name (no "/"), or a peer "<session-id>/lead".`
        );
      }
    }

    const senderName = ctx.core.getName();
    const isChildSender = senderName !== 'lead';

    // Collect ALL missing/invalid required args in one shot, instead of
    // failing on the first one. A single prescriptive error that names every
    // missing field AND shows the exact corrected call lets the LLM repair
    // the call in one retry. The previous first-failure bare string ("name
    // parameter is required…") gave the model no repair guidance, so it
    // frequently re-emitted the same malformed shape and then produced an
    // EMPTY assistant turn — which on a child teammate ends the phase with the
    // deliverable undelivered (observed: sim-b dropped 5 mail_to reports).
    const missing: string[] = [];
    if (!title || typeof title !== 'string') missing.push('title');
    if (!content || typeof content !== 'string') missing.push('content');
    if (!name || typeof name !== 'string') {
      // Child→lead default: a child teammate's report is almost always a reply
      // to the lead, and dropping it for a missing recipient loses the whole
      // deliverable. Default `name="lead"` for a child sender and continue
      // (brief-noted), rather than rejecting the mail.
      if (isChildSender) {
        name = 'lead';
        ctx.core.brief('warn', 'mail_to', 'name parameter missing — defaulted to "lead" for child sender');
      } else {
        missing.push('name');
      }
    }

    if (missing.length > 0) {
      const list = missing.join(', ');
      ctx.core.brief('error', 'mail_to', `Missing or invalid ${list} parameter(s)`);
      const example = missing.includes('name')
        ? 'mail_to(name="lead", title="<subject>", content="<body>")'
        : `mail_to(name="${name}", title="<subject>", content="<body>")`;
      return (
        `Error: missing required argument(s): ${list}. A call to mail_to needs name, title, content. ` +
        `Corrected example: ${example}`
      );
    }

    const isTeammateToLead = name === 'lead' && isChildSender;

    // -------------------------------------------------------------------------
    // NON-ROUTABLE addresses (fail-fast, before any peer/teammate logic).
    //
    // External senders get a three-part address "<app>/<group>/<id>" (e.g.
    // "myview/REDBOX/56232") stamped into `Mail.from` when they push mail into
    // our mailbox. Such an app has NO mycc mailbox we can write to, so a reply
    // is impossible — refusing up front is the honest answer, and it stops the
    // agent from "replying" into the void or inventing a delivery step.
    // Classification lives in src/peer/mail-identity.ts (shared with COLLECT,
    // which renders these senders with an explicit NO-REPLY line).
    const nonRoutableReason = explainNonRoutable(name);
    if (nonRoutableReason) {
      ctx.core.brief('error', 'mail_to', nonRoutableReason);
      return (
        `Error: cannot send mail to '${name}'. ${nonRoutableReason} ` +
        `Valid recipient forms: "lead", a live teammate name (no "/"), or a peer "<session-id>/lead".`
      );
    }

    // UUID format: 8 hex - 4 hex - 4 hex - 4 hex - 12 hex (case-insensitive).
    // Shared by the peer-routing block and the fail-fast recipient validation.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    // -------------------------------------------------------------------------
    // Fail-fast recipient validation (replaces the former soft bare-session-id
    // warning). mail_to is fire-and-forget, so a recipient that doesn't resolve
    // to a KNOWN, live recipient must be rejected up front — otherwise the mail
    // is silently lost and the sender gets a misleading "OK". This turned the
    // silent-failure trap (a bare session-id, a stale/offline peer, or a
    // non-existent teammate name) into an immediate, correctable error.
    //
    // The recipient SHAPES, and which of them mycc can actually address, are
    // decided in ONE place: src/peer/mail-identity.ts (classifySender /
    // explainNonRoutable). In short:
    //   - "lead"            — local IPC sentinel (lead↔teammate). Always OK.
    //   - "<uuid>/lead"     — cross-instance peer. Must be ONLINE; a
    //                         stale/offline peer's mail is dropped anyway, so
    //                         failing fast here is informative and correct.
    //   - "<teammate-name>" — a live teammate in the current roster. Verified
    //                         ONLY in the lead/parent context (a child's
    //                         listTeammates() throws FORBIDDEN and it writes
    //                         mailbox files directly, so there is no roster).
    //   - "<app>/<group>/<id>" — an EXTERNAL sender format: refused above.
    //   - anything else     — refused by the non-routable guard above.
    // -------------------------------------------------------------------------
    if (name !== 'lead') {
      const slashIdx = name.indexOf('/');
      if (slashIdx > 0) {
        const peerSid = name.slice(0, slashIdx);
        const peerAgent = name.slice(slashIdx + 1);
        if (peerAgent === 'lead' && UUID_RE.test(peerSid)) {
          // Valid peer form — fail fast if the peer is NOT online/fresh.
          // sendPeerMail() below re-checks as a backup, but surfacing it here
          // gives a clearer, earlier rejection.
          if (!ctx.peer.isFresh(peerSid)) {
            ctx.core.brief(
              'error',
              'mail_to',
              `Peer ${peerSid} is offline/stale or not registered — mail rejected (fail-fast).`
            );
            return (
              `Error: peer ${peerSid} is offline/stale or not registered. ` +
              `The remote mycc instance may have exited, or its heartbeat is older than the freshness window. ` +
              `Verify the peer is running with myccdp enabled, then resend. Valid recipient forms: ` +
              `"lead", "<session-id>/lead" (online peer), or a live teammate name.`
            );
          }
          // Peer is fresh — fall through to the sendPeerMail call below.
        } else {
          // Slash-bearing name that is NOT a valid <uuid>/lead peer route.
          ctx.core.brief(
            'error',
            'mail_to',
            `Unrecognized recipient '${name}': not a valid "<session-id>/lead" peer route, and teammate names cannot contain "/".`
          );
          return (
            `Error: unrecognized recipient '${name}'. A slash-bearing name must be a valid peer route ` +
            `"<session-id>/lead" with the session-id as a UUID and an ONLINE peer. ` +
            `For cross-instance peer mail use "<session-id>/lead" (verify the peer is online via the peers tool first). ` +
            `For local mail use "lead" or a live teammate name (no "/").`
          );
        }
      } else {
        // Bare teammate name (no "/") — validate against the live roster.
        // Only the lead/parent can enumerate teammates; a child's
        // listTeammates() throws FORBIDDEN, so we skip validation there
        // (the child writes mailbox files directly and has no roster).
        let roster: string[] | null = null;
        try {
          roster = ctx.team.listTeammates().map((t) => t.name);
        } catch {
          // Child context — cannot validate. Leave roster null (skip check).
        }
        if (roster !== null && !roster.includes(name)) {
          ctx.core.brief(
            'error',
            'mail_to',
            `Teammate '${name}' does not exist in the current roster — mail rejected (fail-fast).`
          );
          return (
            `Error: teammate '${name}' does not exist. Use tm_create to spawn a teammate first, ` +
            `or check the name with the tm_print tool. Valid recipient forms: ` +
            `"lead", "<session-id>/lead" (online peer), or a live teammate name.`
          );
        }
      }
    }

    // Cross-instance peer routing: if `name` matches the identity pattern
    // <session-id>/<agent-name> (agent-name is currently only "lead"), route
    // the message through ctx.peer to the remote peer's mailbox instead of
    // local teammate IPC. This makes mail_to work across mycc instances.
    // The session-id part must be a valid UUID (8-4-4-4-12 hex format), and
    // the agent-name part must be "lead". Validating the UUID format (not just
    // "contains a dash") prevents misrouting teammate names that happen to
    // contain a dash + "/lead" (e.g. "review-peer-1/lead") to the peer path.
    // (The fail-fast block above already confirmed the peer is fresh.)
    const peerSlashIdx = name.indexOf('/');
    if (peerSlashIdx > 0) {
      const peerSid = name.slice(0, peerSlashIdx);
      const peerAgent = name.slice(peerSlashIdx + 1);
      if (peerAgent === 'lead' && UUID_RE.test(peerSid)) {
        const ok = ctx.peer.sendPeerMail(peerSid, title, content);
        if (ok) {
          ctx.core.brief('info', 'mail_to', `(peer→${name}) ${title}\n${chalk.gray(content)}`);
          // Channel-completeness check (fix #2): peer mail is channel-INDEPENDENT
          // and just succeeded, but a peer with NO channel pointing back to this
          // sender has no channel-driven path to deliver its REPLY — the reply
          // arrives via the peer's channel poll / firstQuery machinery, which
          // only runs for a channel file pair. Without one, the sender could
          // wait forever for a verdict that can never arrive (observed in the
          // PR #19 peer-restart episode: channel files stayed keyed to dead
          // session-ids, so the live peers never polled them). The mail is still
          // sent — this is a non-blocking advisory appended to the OK result.
          if (!ctx.peer.hasChannelWith(peerSid)) {
            ctx.core.brief(
              'info',
              'mail_to',
              `No channel between this instance and ${peerSid} — replies may not be delivered.`
            );
            return (
              `OK. Peer mail sent to ${name}. WARNING: no channel exists between this instance and ${peerSid}, ` +
              `so the peer has no channel-driven path to deliver a REPLY back — consider establishing a channel ` +
              `with the mail receiver (see the mediator skill), otherwise the peer's response may never arrive.`
            );
          }
          return `OK. Peer mail sent to ${name}.`;
        }
        // Defensive: isFresh passed above but sendPeerMail returned false
        // (e.g. the peer went stale between the check and the send).
        ctx.core.brief(
          'error',
          'mail_to',
          `Peer ${peerSid} delivery failed (sendPeerMail=false) — mail not delivered.`
        );
        return (
          `Error: peer ${peerSid} delivery failed. The peer was fresh at validation but the mailbox write was rejected ` +
          `(the remote instance may have just exited). Verify the peer is running and resend.`
        );
      }
    }

    // Conditional enforcement: child→lead requires eta (seconds from now)
    if (isTeammateToLead) {
      if (eta === undefined) {
        ctx.core.brief(
          'error',
          'mail_to',
          'eta is required when sending to lead. ' +
            'Estimate how long you need in seconds (e.g., eta=120 for ~2 minutes). ' +
            'Set to 0 for non-budget messages (progress updates, lead responses).'
        );
        return (
          'Error: eta is required when sending to lead. ' +
          'Set eta to the number of seconds you need (e.g., eta=120 for 2 minutes). ' +
          'Set to 0 for non-budget messages (progress updates, lead responses).'
        );
      }
      if (typeof eta !== 'number' || !Number.isInteger(eta) || eta < 0) {
        ctx.core.brief('error', 'mail_to', `eta must be a non-negative integer (seconds from now), got: ${eta}`);
        return (
          'Error: eta must be a non-negative integer (seconds from now). ' +
          'Example: eta=120 for about 2 minutes, eta=0 for non-budget messages.'
        );
      }

      // ctx.team.mailTo handles IPC (eta_update) in ChildTeam implementation
      ctx.core.brief('info', 'mail_to', `(...to ${name}) ${title}\n${chalk.gray(content)}`);
      ctx.team.mailTo(name, title, content, undefined, eta);

      if (eta > 0) {
        return `OK. Budget sent to lead: ~${eta}s from now. The lead will wait until the deadline. Extend by sending mail_to with a new eta.`;
      }
      return 'OK';
    }

    // Lead→anyone or child→other: eta is optional, mail as usual
    ctx.core.brief('info', 'mail_to', `(...to ${name}) ${title}\n${chalk.gray(content)}\n`);
    ctx.team.mailTo(name, title, content);
    return 'OK';
  }
};
