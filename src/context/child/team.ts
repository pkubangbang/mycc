/**
 * team.ts - ChildTeam implementation for child process
 *
 * Child team module with restricted capabilities:
 * - mailTo: writes directly to mailbox files
 * - createTeammate: sends mail to lead requesting creation
 * - printTeam: IPC request to get team status
 * - All other operations: FORBIDDEN
 */

import type { TeamModule } from '../../types.js';
import { MailBox } from '../shared/mail.js';
import { ipc } from './ipc-helpers.js';

/**
 * Team module for child process
 * Restricted capabilities - most operations delegate to lead via mail
 */
export class ChildTeam implements TeamModule {
  private owner: string;

  constructor(owner: string) {
    this.owner = owner;
  }

  /**
   * Request lead to create a teammate (via mail)
   * Lead decides whether to act on this suggestion
   */
  async createTeammate(name: string, role: string, prompt: string, cwd?: string): Promise<string> {
    const mail = new MailBox('lead');
    mail.appendMail(
      this.owner,
      'Teammate Creation Request',
      [
        `I suggest creating a teammate:`,
        `- Name: ${name}`,
        `- Role: ${role}`,
        ...(cwd ? [`- Working directory: ${cwd}`] : []),
        ``,
        `Reason/Prompt:`,
        prompt,
        ``,
        `Please decide if this is appropriate.`,
      ].join('\n')
    );
    return `Suggestion sent to lead via mail. Lead will evaluate and decide.`;
  }

  /**
   * FORBIDDEN: Get teammate info not available to child
   */
  getTeammate(): never {
    throw new Error('FORBIDDEN: getTeammate not available to child');
  }

  /**
   * FORBIDDEN: List teammates not available to child
   */
  listTeammates(): never {
    throw new Error('FORBIDDEN: listTeammates not available to child');
  }

  /**
   * FORBIDDEN: Await teammates not available to child
   */
  async awaitTeammates(): Promise<never> {
    throw new Error('FORBIDDEN: awaitTeammates not available to child');
  }

  /**
   * FORBIDDEN: Remove teammate not available to child
   */
  removeTeammate(): never {
    throw new Error('FORBIDDEN: removeTeammate not available to child');
  }

  /**
   * FORBIDDEN: Dismiss team not available to child
   */
  dismissTeam(): never {
    throw new Error('FORBIDDEN: dismissTeam not available to child');
  }

  /**
   * Get team status via IPC
   */
  async printTeam(): Promise<string> {
    const result = await ipc.sendRequest<{ message: string }>('team_print', {});
    return result.message;
  }

  /**
   * Send mail to a teammate or lead
   * If sending to lead with eta>0 (seconds from now), sends IPC 'eta_update'
   * so the parent's TeamManager can track the deadline.
   */
  mailTo(name: string, title: string, content: string, from?: string, eta?: number): void {
    const mail = new MailBox(name);
    mail.appendMail(from ?? this.owner, title, content);

    // If this is child→lead with a positive eta, send IPC for budget tracking
    if (name === 'lead' && eta !== undefined && Number.isInteger(eta) && eta > 0) {
      const absoluteEta = Math.floor(Date.now() / 1000) + eta;
      ipc.sendNotification('eta_update', { eta: absoluteEta, sender: from ?? this.owner });
    }
  }

  /**
   * Interface satisfier only — `TeamModule.broadcast` is shared with the parent
   * implementation, but `broadcast` itself is a MAIN-ONLY tool, so no child code
   * path can ever reach this method (`broadcast.ts` is not in the child's
   * schema, and there is no `team_broadcast` IPC to forward through). It throws
   * rather than silently forwarding a request the lead cannot fulfil, so an
   * accidental future call fails loudly instead of quietly doing nothing.
   */
  broadcast(_title: string, _content: string): void {
    throw new Error('broadcast is lead-only; a teammate cannot broadcast');
  }

  /**
   * Handle pending questions (no-op for child)
   */
  async handlePendingQuestions(): Promise<void> {
    // No-op in child - only lead handles questions
  }
}