/**
 * mail.ts - Mail module: append-only mailbox files
 */

import * as fs from 'fs';
import * as path from 'path';
import type { MailModule, Mail as MailType } from '../../types.js';
import { getMailDir, ensureDirs } from '../../config.js';

/**
 * Mail module implementation
 */
export class MailBox implements MailModule {
  private owner: string;

  constructor(owner: string) {
    this.owner = owner;
  }

  /**
   * Get the mailbox file path for this owner
   */
  private getMailPath(): string {
    return path.join(getMailDir(), `${this.owner}.jsonl`);
  }

  /**
   * Append a mail to the mailbox
   */
  appendMail(from: string, title: string, content: string, issueId?: number): void {
    ensureDirs();

    const mailPath = this.getMailPath();
    const mail: MailType = {
      id: generateId(),
      from,
      title,
      content,
      issueId,
      timestamp: new Date(),
    };

    // Append to file (atomic append)
    const line = `${JSON.stringify(mail)  }\n`;
    fs.appendFileSync(mailPath, line, 'utf-8');
  }

  /**
   * Check if there are new mails without consuming them
   */
  hasNewMails(): boolean {
    const mailPath = this.getMailPath();

    if (!fs.existsSync(mailPath)) {
      return false;
    }

    const content = fs.readFileSync(mailPath, 'utf-8');
    return content.trim().length > 0;
  }

  /**
   * Collect all mails and clear the mailbox
   * Atomic: read file, then truncate
   */
  collectMails(): MailType[] {
    const mailPath = this.getMailPath();

    if (!fs.existsSync(mailPath)) {
      return [];
    }

    // Read entire file
    const content = fs.readFileSync(mailPath, 'utf-8');
    if (!content.trim()) {
      return [];
    }

    // Truncate file (clear it)
    fs.truncateSync(mailPath, 0);

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