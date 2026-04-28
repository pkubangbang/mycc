/**
 * hook-preprocessor.ts - Tool call augmentation for hook evaluation
 *
 * Augments tool calls with metadata that can be used by hook conditions
 * to make decisions (e.g., file path, test file detection, destructive commands).
 */

import * as fs from 'fs';
import type { ToolCall } from '../types.js';
import type { AugmentedToolCall } from './hook-executor.js';

/**
 * Check if a bash command is destructive
 */
function isDestructiveCommand(command: string): boolean {
  const destructivePatterns = [
    /rm\s+-rf/,
    /rm\s+-r/,
    /git\s+push\s+--force/,
    /git\s+push\s+-f\s+/,
    /git\s+reset\s+--hard/,
    /drop\s+database/i,
    /truncate\s+table/i,
    /delete\s+from/i,
    /\bsudo\s+rm\b/,
    />\s*\/dev\/(sda|hda|nvme)/,
  ];
  return destructivePatterns.some(p => p.test(command));
}

/**
 * Augment a single tool call with metadata
 */
export function augmentCall(call: ToolCall): AugmentedToolCall {
  const args = call.function.arguments as Record<string, unknown>;
  const metadata: AugmentedToolCall['metadata'] = {};

  switch (call.function.name) {
    case 'write_file':
    case 'edit_file': {
      metadata.filePath = args.file_path as string;
      metadata.isTestFile = metadata.filePath?.includes('.test.') || metadata.filePath?.includes('.spec.');
      if (args.content && typeof args.content === 'string') {
        metadata.newLoc = args.content.split('\n').length;
      }
      // Check existing file LOC
      if (metadata.filePath && fs.existsSync(metadata.filePath)) {
        try {
          const existing = fs.readFileSync(metadata.filePath, 'utf-8');
          metadata.existingLoc = existing.split('\n').length;
        } catch {
          // Ignore read errors
        }
      }
      break;
    }

    case 'bash': {
      if (args.command && typeof args.command === 'string') {
        metadata.isDestructive = isDestructiveCommand(args.command);
      }
      break;
    }
  }

  return { ...call, metadata };
}

/**
 * Augment an array of tool calls with metadata for hook evaluation
 */
export function augmentToolCalls(calls: ToolCall[]): AugmentedToolCall[] {
  return calls.map(call => augmentCall(call));
}