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

export const mailToTool: ToolDefinition = {
  name: 'mail_to',
  description: 'Send an async message to a teammate or "lead". Non-blocking - does not wait for response. Use for task assignment and inter-agent communication. Include meaningful content.',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Target name to receive the message. A teammate name or "lead" for local instance IPC, OR a cross-instance peer identity "<session-id>/lead" (e.g. "3b1b83d.../lead") to route through the peer discovery module to a remote mycc instance mailbox.',
      },
      title: {
        type: 'string',
        description: 'Message title/subject',
      },
      content: {
        type: 'string',
        description: 'Message body content',
      },
      eta: {
        type: 'number',
        description: 'MANDATORY when a teammate sends the first (or extension) mail to lead. Estimate duration in seconds. ' +
          'Example: eta=120 means "I need about 2 minutes". The system will convert this to an absolute deadline. ' +
          'Set to 0 or omit for non-budget messages (progress updates, lead responses).',
      },
    },
    required: ['name', 'title', 'content'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const name = args.name as string;
    const title = args.title as string;
    const content = args.content as string;
    const eta = args.eta as number | undefined;

    // Validate required parameters
    if (!name || typeof name !== 'string') {
      ctx.core.brief('error', 'mail_to', 'Missing or invalid name parameter');
      return 'Error: name parameter is required and must be a string';
    }
    if (!title || typeof title !== 'string') {
      ctx.core.brief('error', 'mail_to', 'Missing or invalid title parameter');
      return 'Error: title parameter is required and must be a string';
    }
    if (!content || typeof content !== 'string') {
      ctx.core.brief('error', 'mail_to', 'Missing or invalid content parameter');
      return 'Error: content parameter is required and must be a string';
    }

    const senderName = ctx.core.getName();
    const isTeammateToLead = name === 'lead' && senderName !== 'lead';

    // Cross-instance peer routing: if `name` matches the identity pattern
    // <session-id>/<agent-name> (agent-name is currently only "lead"), route
    // the message through ctx.peer to the remote peer's mailbox instead of
    // local teammate IPC. This makes mail_to work across mycc instances.
    // The session-id part must be a valid UUID (8-4-4-4-12 hex format), and
    // the agent-name part must be "lead". Validating the UUID format (not just
    // "contains a dash") prevents misrouting teammate names that happen to
    // contain a dash + "/lead" (e.g. "review-peer-1/lead") to the peer path.
    const peerSlashIdx = name.indexOf('/');
    if (peerSlashIdx > 0) {
      const peerSid = name.slice(0, peerSlashIdx);
      const peerAgent = name.slice(peerSlashIdx + 1);
      // UUID format: 8 hex - 4 hex - 4 hex - 4 hex - 12 hex (case-insensitive)
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (peerAgent === 'lead' && UUID_RE.test(peerSid)) {
        const ok = ctx.peer.sendPeerMail(peerSid, title, content);
        if (ok) {
          ctx.core.brief('info', 'mail_to', `(peer→${name}) ${title}\n${chalk.gray(content)}`);
          return `OK. Peer mail sent to ${name}.`;
        }
        ctx.core.brief('error', 'mail_to', `Peer ${peerSid} is stale or not registered — mail not delivered.`);
        return `Error: peer ${peerSid} is stale or not registered. The remote mycc instance may have exited, or its heartbeat is older than the freshness window. Verify the peer is running with myccdp enabled.`;
      }
    }

    // Conditional enforcement: child→lead requires eta (seconds from now)
    if (isTeammateToLead) {
      if (eta === undefined) {
        ctx.core.brief('error', 'mail_to',
          'eta is required when sending to lead. ' +
          'Estimate how long you need in seconds (e.g., eta=120 for ~2 minutes). ' +
          'Set to 0 for non-budget messages (progress updates, lead responses).');
        return 'Error: eta is required when sending to lead. ' +
               'Set eta to the number of seconds you need (e.g., eta=120 for 2 minutes). ' +
               'Set to 0 for non-budget messages (progress updates, lead responses).';
      }
      if (typeof eta !== 'number' || !Number.isInteger(eta) || eta < 0) {
        ctx.core.brief('error', 'mail_to',
          `eta must be a non-negative integer (seconds from now), got: ${eta}`);
        return 'Error: eta must be a non-negative integer (seconds from now). ' +
               'Example: eta=120 for about 2 minutes, eta=0 for non-budget messages.';
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
  },
};
