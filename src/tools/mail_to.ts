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
  description: 'Send an async message to a teammate or "lead" within the current mycc instance (intra-session IPC). Non-blocking - does not wait for response. Use for task assignment and inter-agent communication between the lead and its teammates. For cross-instance mail (to a remote mycc instance or a cronjob-triggered lead), use the `mycc-mail` CLI via the bash tool (e.g. `mycc-mail <session-id> --title "..." --content "..."`); this tool does NOT route to other mycc instances.',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Target name to receive the message. A teammate name or "lead" for local instance IPC. Cross-instance mail (remote mycc instances, cronjobs) is handled by the `mycc-mail` CLI, NOT this tool — slash-bearing names like "<session-id>/lead" are rejected with a pointer to the CLI.',
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

    // -------------------------------------------------------------------------
    // Recipient validation — intra-session only.
    //
    // mail_to is scoped to communication WITHIN the current mycc instance:
    //   1. "lead"               — local IPC sentinel (lead↔teammate). Always OK.
    //   2. "<teammate-name>"    — a live teammate in the current instance's
    //                            roster. Validated via ctx.team.listTeammates()
    //                            ONLY in the lead/parent context — a child
    //                            teammate's listTeammates() throws FORBIDDEN, and
    //                            the child writes mailbox files directly, so it
    //                            cannot validate; we skip the check there.
    //
    // Cross-instance / external mail (cronjobs, other mycc instances, the
    // mediator pattern) is handled by the `mycc-mail` CLI — a standalone
    // script (scripts/mycc-mail/mycc-mail.js, exposed as a global bin) that
    // appends a JSONL line to a remote lead's mailbox. Any slash-bearing name
    // (e.g. "<uuid>/lead", "<bad-uuid>/lead") is rejected here with a pointer
    // to the CLI: the agent should run the CLI via the bash tool instead.
    // -------------------------------------------------------------------------
    if (name !== 'lead') {
      const slashIdx = name.indexOf('/');
      if (slashIdx > 0) {
        ctx.core.brief('error', 'mail_to',
          `Cross-instance mail is handled by the \`mycc-mail\` CLI, not mail_to. Recipient '${name}' contains a "/" (peer/cross-session form).`);
        return `Error: cross-instance mail is handled by the \`mycc-mail\` CLI, not the mail_to tool.\n` +
          `Recipient '${name}' looks like a cross-session form ("<session-id>/lead").\n` +
          `To send mail to a remote mycc instance, run via the bash tool:\n` +
          `  mycc-mail <session-id> --title "<title>" --content "<content>"\n` +
          `Discover the target session-id with the peers tool (or \`mycc-mail --list\`).\n` +
          `mail_to is scoped to intra-session communication: "lead" or a live teammate name (no "/").`;
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
          ctx.core.brief('error', 'mail_to',
            `Teammate '${name}' does not exist in the current roster — mail rejected (fail-fast).`);
          return `Error: teammate '${name}' does not exist. Use tm_create to spawn a teammate first, ` +
            `or check the name with the tm_print tool. Valid recipient forms: ` +
            `"lead" or a live teammate name. For cross-instance mail use the \`mycc-mail\` CLI.`;
        }
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
