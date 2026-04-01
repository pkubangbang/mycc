/**
 * transcript.ts - Transcript logging for debugging
 *
 * Logs all communication to a file for debugging purposes:
 * - ctx.core.brief() - log messages
 * - ctx.core.question() - user questions and responses
 * - mail_to / ctx.team.mailTo() - sending mail to others
 * - ctx.mail.appendMail() - leaving mail for yourself
 */

import * as fs from 'fs';
import * as path from 'path';
import type { TranscriptModule, TranscriptEntry } from '../types.js';
import { getMyccDir, ensureDirs } from './db.js';

/**
 * Transcript module implementation
 */
export class Transcript implements TranscriptModule {
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /**
   * Log an entry to the transcript file
   */
  log(entry: TranscriptEntry): void {
    const line = JSON.stringify({
      ...entry,
      timestamp: entry.timestamp.toISOString(),
    }) + '\n';
    fs.appendFileSync(this.filePath, line, 'utf-8');
  }

  /**
   * Log a brief message
   */
  logBrief(level: string, tool: string, message: string): void {
    this.log({
      timestamp: new Date(),
      type: 'brief',
      level,
      tool,
      message,
    });
  }

  /**
   * Log a question asked to the user
   */
  logQuestion(asker: string, query: string): void {
    this.log({
      timestamp: new Date(),
      type: 'question',
      asker,
      query,
    });
  }

  /**
   * Log a user's response to a question
   */
  logAnswer(asker: string, response: string): void {
    this.log({
      timestamp: new Date(),
      type: 'answer',
      asker,
      response,
    });
  }

  /**
   * Log mail being sent (both mail_to and appendMail)
   */
  logMailSend(from: string, to: string, title: string, content?: string): void {
    this.log({
      timestamp: new Date(),
      type: 'mail_send',
      from,
      to,
      title,
      content,
    });
  }
}

/**
 * Get the transcript directory path
 */
export function getTranscriptDir(): string {
  return path.join(getMyccDir(), 'transcripts');
}

/**
 * Create a new transcript file with timestamp
 */
export function createTranscript(): TranscriptModule {
  ensureDirs();

  const transcriptDir = getTranscriptDir();
  if (!fs.existsSync(transcriptDir)) {
    fs.mkdirSync(transcriptDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filePath = path.join(transcriptDir, `session-${timestamp}.log`);

  // Write header
  fs.writeFileSync(filePath, '', 'utf-8');

  return new Transcript(filePath);
}