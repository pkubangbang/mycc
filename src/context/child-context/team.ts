/**
 * team.ts - ChildTeam implementation for child process
 *
 * mailTo writes directly to mailbox files (same as parent process).
 * Other operations (createTeammate, awaitTeammate) use IPC.
 */

import type { TeamModule, Teammate, TeammateStatus, IpcHandlerRegistration } from '../../types.js';
import { createMail } from '../mail.js';
import { ipc } from './ipc-helpers.js';

/**
 * Team module for child process
 * mailTo writes directly to file, other operations use IPC
 */
export class ChildTeam implements TeamModule {
  private owner: string;
  private handlers: Map<string, IpcHandlerRegistration> = new Map();

  constructor(owner: string) {
    this.owner = owner;
  }

  async createTeammate(name: string, role: string, prompt: string): Promise<string> {
    const result = await ipc.sendRequest<string>('team_create', { name, role, prompt });
    return result;
  }

  getTeammate(name: string): Teammate | undefined {
    // Synchronous operation not supported via IPC
    throw new Error('getTeammate not available in child process');
  }

  listTeammates(): { name: string; role: string; status: TeammateStatus }[] {
    // Synchronous operation not supported via IPC
    return [];
  }

  async awaitTeammate(name: string, timeout?: number): Promise<void> {
    await ipc.sendRequest<void>('team_await', { name, timeout });
  }

  async awaitTeam(timeout?: number): Promise<{ allSettled: boolean }> {
    const result = await ipc.sendRequest<{ allSettled: boolean }>('team_await_all', { timeout });
    return result;
  }

  printTeam(): string {
    return 'Use mail_to to ask the lead about the team status.';
  }

  removeTeammate(name: string, force?: boolean): void {
    throw new Error('removeTeammate not available in child process');
  }

  dismissTeam(force?: boolean): void {
    throw new Error('dismissTeam not available in child process');
  }

  /**
   * Send mail to a teammate or lead
   * Writes directly to mailbox file - no IPC needed
   */
  mailTo(name: string, title: string, content: string, from?: string): void {
    const mail = createMail(name);
    mail.appendMail(from ?? this.owner, title, content);
  }

  /**
   * Broadcast to all teammates
   * Note: In child process, we don't know all teammates, so this just logs
   */
  broadcast(title: string, content: string): void {
    // In child process, we don't have access to teammate list
    // Use mailTo to send to specific teammates instead
    throw new Error('broadcast not available in child process - use mailTo for specific recipients');
  }

  registerHandler(registration: IpcHandlerRegistration): void {
    this.handlers.set(registration.messageType, registration);
  }

  unregisterHandler(messageType: string): void {
    this.handlers.delete(messageType);
  }

  setTranscript(): void {
    // No-op in child - transcript handled by parent
  }

  /**
   * Handle pending questions from children
   * No-op in child process - only the lead handles questions
   */
  async handlePendingQuestions(): Promise<void> {
    // No-op in child process
  }
}

/**
 * Create a child team module
 */
export function createChildTeam(owner: string): TeamModule {
  return new ChildTeam(owner);
}