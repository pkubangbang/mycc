/**
 * core.ts - ChildCore implementation for IPC-based core operations
 */

import type { CoreModule, TranscriptModule } from '../../types.js';
import { sendLog, sendError, sendRequest } from './ipc-helpers.js';

/**
 * Core module for child process
 * All operations go through IPC to parent
 */
export class ChildCore implements CoreModule {
  private workDir: string;
  private name: string;

  constructor(name: string, workDir: string) {
    this.name = name;
    this.workDir = workDir;
  }

  getWorkDir(): string {
    return this.workDir;
  }

  setWorkDir(dir: string): void {
    this.workDir = dir;
  }

  brief(level: 'info' | 'warn' | 'error', tool: string, message: string): void {
    const formatted = `[${tool}] ${message}`;
    if (level === 'error') {
      sendError(formatted);
    } else {
      sendLog(formatted);
    }
  }

  async question(query: string, asker?: string): Promise<string> {
    // Use no timeout for user questions - user can take arbitrary time to respond
    const response = await sendRequest<{ response: string }>('question', {
      query,
      asker: asker || this.name,
    }, 0);
    return response.response;
  }

  setQuestionFn(): void {
    // No-op in child - questions go via IPC
  }

  setTranscript(_transcript: TranscriptModule): void {
    // No-op in child - transcript is handled by parent process
  }
}

/**
 * Create a child core module
 */
export function createChildCore(name: string, workDir: string): CoreModule {
  return new ChildCore(name, workDir);
}