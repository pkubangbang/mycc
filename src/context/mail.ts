/**
 * mail.ts - Mail module: append-only mailbox files
 */

import * as fs from 'fs';
import * as path from 'path';
import type { MailModule, Mail as MailType, TranscriptModule } from '../types.js';
import { getMailDir, ensureDirs } from './db.js';

/**
 * Mail module implementation
 */
export class MailBox implements MailModule {
  private owner: string;
  private transcript: TranscriptModule | null = null;

  constructor(owner: string) {
    this.owner = owner;
  }

  /**
   * Set the transcript module for logging
   */
  setTranscript(transcript: TranscriptModule): void {
    this.transcript = transcript;
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
    const line = JSON.stringify(mail) + '\n';
    fs.appendFileSync(mailPath, line, 'utf-8');

    // Log to transcript (mail to self)
    if (this.transcript) {
      this.transcript.logMailSend(from, this.owner, title, content);
    }
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
    fs.writeFileSync(mailPath, '', 'utf-8');

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

/**
 * Create a mail module instance
 */
export function createMail(owner: string): MailModule {
  return new MailBox(owner);
}