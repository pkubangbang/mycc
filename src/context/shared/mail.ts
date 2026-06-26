/**
 * mail.ts - Mail module: append-only mailbox files
 *
 * Session-based file structure (no timestamp — session directory provides isolation):
 *   .mycc/sessions/{session-id}/
 *     unread-{owner}.jsonl    ← inbox (truncated on collect)
 *     readmail-{owner}.jsonl   ← backlog (append-only)
 *
 * When a teammate re-spawns, stale unread mail from a previous incarnation
 * is cleared by the parent via clearUnread() before the new spawn message.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { MailModule, Mail as MailType } from '../../types.js';
import { getSessionDir, getSessionContext, ensureDirs } from '../../config.js';

/**
 * Mail module implementation
 *
 * NOTE: Prefer using `context.mail` (the MailModule instance on AgentContext)
 * over creating a new `MailBox` directly. The context already has a shared
 * instance — creating a new one is wasteful and bypasses the module interface.
 * Only use `new MailBox(...)` when you don't have access to AgentContext
 * (e.g., in standalone utility code or test setup).
 */
export class MailBox implements MailModule {
  private owner: string;

  constructor(owner: string) {
    this.owner = owner;
  }

  /**
   * Get the session directory for this mailbox
   * Throws if session context is not initialized (fail-fast).
   */
  private sessionDir(): string {
    return getSessionDir(getSessionContext());
  }

  /**
   * Get the unread mailbox file path for this owner
   */
  private getUnreadPath(): string {
    return path.join(this.sessionDir(), `unread-${this.owner}.jsonl`);
  }

  /**
   * Get the readmail (backlog) file path for this owner
   */
  private getReadmailPath(): string {
    return path.join(this.sessionDir(), `readmail-${this.owner}.jsonl`);
  }

  /**
   * Clear all unread mail for this owner (used when re-spawning a teammate).
   */
  clearUnread(): void {
    const p = this.getUnreadPath();
    if (fs.existsSync(p)) {
      fs.truncateSync(p, 0);
    }
  }

  /**
   * Append a mail to the mailbox (writes to unread file)
   */
  appendMail(from: string, title: string, content: string, issueId?: number): void {
    ensureDirs();

    const mailPath = this.getUnreadPath();
    const mail: MailType = {
      id: generateId(),
      from,
      title,
      content,
      issueId,
      timestamp: new Date(),
    };

    // Append to file (atomic append)
    const line = `${JSON.stringify(mail)}\n`;
    fs.appendFileSync(mailPath, line, 'utf-8');
  }

  /**
   * Check if there are new mails without consuming them
   */
  hasNewMails(): boolean {
    const mailPath = this.getUnreadPath();

    if (!fs.existsSync(mailPath)) {
      return false;
    }

    const content = fs.readFileSync(mailPath, 'utf-8');
    return content.trim().length > 0;
  }

  /**
   * List all mails without consuming them (read-only peek)
   */
  listMails(): MailType[] {
    const mailPath = this.getUnreadPath();

    if (!fs.existsSync(mailPath)) {
      return [];
    }

    const content = fs.readFileSync(mailPath, 'utf-8');
    if (!content.trim()) {
      return [];
    }

    const lines = content.trim().split('\n');
    const mails: MailType[] = [];

    for (const line of lines) {
      try {
        const mail = JSON.parse(line) as MailType;
        mail.timestamp = new Date(mail.timestamp);
        mails.push(mail);
      } catch {
        // Skip malformed lines
      }
    }

    return mails;
  }

  /**
   * Collect all mails and move them to the readmail backlog
   * Atomic: read unread file, append to readmail, then truncate unread
   */
  collectMails(): MailType[] {
    const unreadPath = this.getUnreadPath();

    if (!fs.existsSync(unreadPath)) {
      return [];
    }

    // Read entire file
    const content = fs.readFileSync(unreadPath, 'utf-8');
    if (!content.trim()) {
      return [];
    }

    // Append to readmail backlog before clearing unread
    const readmailPath = this.getReadmailPath();
    fs.appendFileSync(readmailPath, content, 'utf-8');

    // Truncate unread file (clear it)
    fs.truncateSync(unreadPath, 0);

    // Parse lines
    const lines = content.trim().split('\n');
    const mails: MailType[] = [];

    for (const line of lines) {
      try {
        const mail = JSON.parse(line) as MailType;
        // Parse date strings back to Date objects
        mail.timestamp = new Date(mail.timestamp);
        mails.push(mail);
      } catch {
        // Skip malformed lines
      }
    }

    return mails;
  }
}

/**
 * Generate a unique ID
 */
function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}
