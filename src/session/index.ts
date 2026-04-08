/**
 * session/index.ts - Session file management
 *
 * On every fresh start, a JSON session file is created at
 * .mycc/sessions/[yyyyMMdd]-[uuid].json
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Get the sessions directory path
 */
export function getSessionsDir(): string {
  return path.join('.mycc', 'sessions');
}

/**
 * Create a new session file on fresh start.
 *
 * Filename format: [yyyyMMdd]-[uuid].json
 * Content: { create_time: "<ISO 8601 timestamp>" }
 *
 * @returns The path of the created session file
 */
export function createSessionFile(): string {
  const sessionsDir = getSessionsDir();

  // Ensure the sessions directory exists
  if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
  }

  const now = new Date();
  const datePart = now.toISOString().slice(0, 10).replace(/-/g, ''); // yyyyMMdd
  const uuid = randomUUID();
  const filename = `${datePart}-${uuid}.json`;

  const content = {
    create_time: now.toISOString(),
  };

  const filePath = path.join(sessionsDir, filename);
  fs.writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf-8');

  return filePath;
}