/**
 * file-input-provider.ts - File-based input provider for autonomous mode
 *
 * Reads instructions from a JSONL file instead of TTY. Used when
 * MYCC_AUTO_IN_JSONL environment variable is set.
 *
 * Each line in the file is a JSON object: {"content":"instruction text"}
 * Multiple lines are joined into a single query.
 *
 * Read-and-clear semantics: when content is found, the file is read
 * entirely, truncated to 0, and all lines joined as one query.
 */

import * as fs from 'fs';
import type { InputProvider } from './input-provider.js';

export class FileInputProvider implements InputProvider {
  readonly name = 'file';

  constructor(
    private inputPath: string,
    private pollMs: number = 500,
  ) {}

  async getInput(): Promise<string | null> {
    while (true) {
      try {
        const content = fs.readFileSync(this.inputPath, 'utf-8');
        if (content.trim()) {
          // Clear file (truncate to 0)
          fs.truncateSync(this.inputPath, 0);
          // Parse each line as JSON, extract content, join as one query
          const lines = content.trim().split('\n');
          const queries = lines.map((line) => {
            const obj = JSON.parse(line) as { content: string };
            return obj.content;
          });
          return queries.join('\n');
        }
      } catch {
        // File doesn't exist or read error — keep polling
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }

  async promptRetry(_errorMessage: string): Promise<boolean> {
    // Autonomous mode: don't retry, let the error be visible
    return false;
  }
}