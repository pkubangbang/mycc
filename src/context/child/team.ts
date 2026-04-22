/**
 * team.ts - ChildTeam implementation for child process
 *
 * Child team module with restricted capabilities:
 * - mailTo: writes directly to mailbox files
 * - broadcast: sends mail to lead requesting broadcast
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
  async createTeammate(name: string, role: string, prompt: string): Promise<string> {
    const mail = new MailBox('lead');
    mail.appendMail(
      this.owner,
      'Teammate Creation Request',
      [
        `I suggest creating a teammate:`,
        `- Name: ${name}`,
        `- Role: ${role}`,
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
   * FORBIDDEN: Await teammate not available to child
   */
  async awaitTeammate(): Promise<never> {
    throw new Error('FORBIDDEN: awaitTeammate not available to child');
  }

  /**
   * FORBIDDEN: Await team not available to child
   */
  async awaitTeam(): Promise<never> {
    throw new Error('FORBIDDEN: awaitTeam not available to child');
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
   * Writes directly to mailbox file
   */
  mailTo(name: string, title: string, content: string, from?: string): void {
    const mail = new MailBox(name);
    mail.appendMail(from ?? this.owner, title, content);
  }

  /**
   * Request lead to broadcast to all teammates
   * Lead decides whether to broadcast
   */
  broadcast(title: string, content: string): void {
    const mail = new MailBox('lead');
    mail.appendMail(
      this.owner,
      'Broadcast Request',
      [
        `I suggest broadcasting to the team:`,
        ``,
        `Title: ${title}`,
        ``,
        `Content:`,
        content,
        ``,
        `Please decide if this should be broadcast.`,
      ].join('\n')
    );
  }

  /**
   * Handle pending questions (no-op for child)
   */
  async handlePendingQuestions(): Promise<void> {
    // No-op in child - only lead handles questions
  }
}