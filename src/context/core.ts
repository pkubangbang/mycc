/**
 * core.ts - Core module: workdir and logging
 */

import type { CoreModule } from '../types.js';

/**
 * Core module implementation
 */
export class Core implements CoreModule {
  private workDir: string;

  constructor(workDir?: string) {
    this.workDir = workDir || process.cwd();
  }

  /**
   * Get current working directory
   */
  getWorkDir(): string {
    return this.workDir;
  }

  /**
   * Set current working directory
   */
  setWorkDir(dir: string): void {
    this.workDir = dir;
  }

  /**
   * Log a message to console
   * Thread-safe: console.log is atomic in Node.js
   */
  brief(level: 'info' | 'warn' | 'error', tool: string, message: string): void {
    const timestamp = new Date().toISOString().slice(11, 19);
    const prefix = `[${timestamp}] [${tool}]`;

    switch (level) {
      case 'error':
        console.error(`\x1b[31m${prefix} ERROR: ${message}\x1b[0m`);
        break;
      case 'warn':
        console.warn(`\x1b[33m${prefix} WARN: ${message}\x1b[0m`);
        break;
      default:
        console.log(`${prefix} ${message}`);
    }
  }
}

/**
 * Create a core module instance
 */
export function createCore(workDir?: string): CoreModule {
  return new Core(workDir);
}