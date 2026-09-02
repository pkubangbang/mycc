/**
 * hook-preprocessor.test.ts - Regression tests for augmentCall metadata.
 *
 * Guards the producer side of the filePath contract: the write_file/edit_file
 * tool schemas name their path parameter `path`, so augmentCall must read
 * `args.path` (not `args.file_path`). An earlier bug read `file_path`, which
 * left metadata.filePath undefined and silently dead-coded every hook
 * reading call.metadata.filePath (e.g. the "block test files over N lines"
 * pattern in conditions.ts). The existing filePath-condition.test.ts only
 * tested the evaluator with manually-injected metadata, so it never caught
 * the producer-side mismatch — this test does.
 */

import { describe, it, expect } from 'vitest';
import { augmentCall } from '../../hook/hook-preprocessor.js';
import type { ToolCall } from '../../types.js';

function makeCall(name: string, args: Record<string, unknown>): ToolCall {
  return {
    id: 'call_1',
    type: 'function',
    function: { name, arguments: args },
  } as unknown as ToolCall;
}

describe('augmentCall — filePath contract (args.path, not args.file_path)', () => {
  it('reads args.path for write_file', () => {
    const call = makeCall('write_file', { path: '/proj/src/a.ts', content: 'line1\nline2\n' });
    const aug = augmentCall(call);
    expect(aug.metadata).toBeDefined();
    expect(aug.metadata!.filePath).toBe('/proj/src/a.ts');
    // 'line1\nline2\n'.split('\n') => ['line1','line2',''] = 3 lines
    expect(aug.metadata!.newLoc).toBe(3);
  });

  it('reads args.path for edit_file', () => {
    const call = makeCall('edit_file', { path: '/proj/src/b.ts', old_text: 'x', new_text: 'y' });
    const aug = augmentCall(call);
    expect(aug.metadata).toBeDefined();
    expect(aug.metadata!.filePath).toBe('/proj/src/b.ts');
  });

  it('does NOT read args.file_path (the old buggy field)', () => {
    // If augmentCall regresses to reading file_path, filePath is undefined
    // here (no `path` key present), which is the exact dead-hook symptom.
    const call = makeCall('write_file', { file_path: '/proj/src/c.ts', content: '' });
    const aug = augmentCall(call);
    expect(aug.metadata).toBeDefined();
    expect(aug.metadata!.filePath).toBeUndefined();
  });
});

describe('augmentCall — bash destructive command detection', () => {
  it('flags rm -rf as destructive', () => {
    const call = makeCall('bash', { command: 'rm -rf node_modules' });
    const aug = augmentCall(call);
    expect(aug.metadata!.isDestructive).toBe(true);
  });

  it('flags git push --force as destructive', () => {
    const call = makeCall('bash', { command: 'git push --force origin main' });
    const aug = augmentCall(call);
    expect(aug.metadata!.isDestructive).toBe(true);
  });

  it('flags git reset --hard as destructive', () => {
    const call = makeCall('bash', { command: 'git reset --hard HEAD~1' });
    const aug = augmentCall(call);
    expect(aug.metadata!.isDestructive).toBe(true);
  });

  it('flags drop database as destructive (case-insensitive)', () => {
    const call = makeCall('bash', { command: 'DROP DATABASE mydb' });
    const aug = augmentCall(call);
    expect(aug.metadata!.isDestructive).toBe(true);
  });

  it('does NOT flag a safe command as destructive', () => {
    const call = makeCall('bash', { command: 'ls -la' });
    const aug = augmentCall(call);
    expect(aug.metadata!.isDestructive).toBe(false);
  });

  it('does NOT flag a plain rm without -rf', () => {
    const call = makeCall('bash', { command: 'rm file.txt' });
    const aug = augmentCall(call);
    expect(aug.metadata!.isDestructive).toBe(false);
  });

  it('leaves isDestructive undefined when command is missing', () => {
    const call = makeCall('bash', {});
    const aug = augmentCall(call);
    expect(aug.metadata!.isDestructive).toBeUndefined();
  });
});