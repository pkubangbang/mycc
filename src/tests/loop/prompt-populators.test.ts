/**
 * prompt-populators.test.ts
 *
 * Unit test for buildPlatformCalendarMessages() in src/loop/prompt-populators.ts.
 *
 * These (## Platform, ## Calendar) sections used to be inlined into the system
 * prompt (prompts/common.ts buildCommonSections and the lead.ts plan-mode
 * base prompt) — rebuilt on
 * every LLM call, so the volatile content (date, PIDs) invalidated the
 * prompt-cache prefix every turn. They now live in a projectContext populator
 * registered at startup and rebuilt only at compact/clear boundaries (commit
 * ab73acc registry pattern), keeping the system prompt byte-stable.
 *
 * This test pins the populator's contract: it returns exactly one user +
 * one assistant message whose user content carries the ## Platform and
 * ## Calendar sections (with the current date), i.e. the info still reaches the
 * LLM in full via projectContext even though it is no longer in the system prompt.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { buildPlatformCalendarMessages, buildNodeModulesReminderMessages } from '../../loop/prompt-populators.js';

describe('buildPlatformCalendarMessages', () => {
  it('returns a user + assistant message pair', () => {
    const messages = buildPlatformCalendarMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[1].role).toBe('assistant');
  });

  it('emits the ## Platform section in the user content', () => {
    const [user] = buildPlatformCalendarMessages();
    expect(user.content).toContain('## Platform');
    expect(user.content).toContain('Platform:');
    expect(user.content).toContain('Shell:');
    expect(user.content).toContain('### Shell Commands');
    expect(user.content).toContain('### Escaping');
    expect(user.content).toContain('### Process PIDs');
  });

  it('emits the ## Calendar section with the current date in the user content', () => {
    const [user] = buildPlatformCalendarMessages();
    const today = new Date().toISOString().split('T')[0];
    expect(user.content).toContain('## Calendar');
    expect(user.content).toContain(`Current date: ${today}`);
  });

  it('keeps the Platform section before the Calendar section (matches old inline order)', () => {
    const [user] = buildPlatformCalendarMessages();
    const platformIdx = user.content.indexOf('## Platform');
    const calendarIdx = user.content.indexOf('## Calendar');
    expect(platformIdx).toBeGreaterThanOrEqual(0);
    expect(calendarIdx).toBeGreaterThan(platformIdx);
  });
});

describe('buildNodeModulesReminderMessages', () => {
  // Helper: run a callback with cwd set to a temp dir, restoring cwd after.
  function withTempCwd<T>(fn: () => T): T {
    const originalCwd = process.cwd();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-populator-test-'));
    process.chdir(tmpDir);
    try {
      return fn();
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  it('returns an empty array when node_modules does not exist', () => {
    withTempCwd(() => {
      const messages = buildNodeModulesReminderMessages();
      expect(messages).toEqual([]);
    });
  });

  it('returns a user + assistant pair when node_modules exists', () => {
    withTempCwd(() => {
      fs.mkdirSync(path.join(process.cwd(), 'node_modules'));
      const messages = buildNodeModulesReminderMessages();
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe('user');
      expect(messages[1].role).toBe('assistant');
    });
  });

  it('emits the node_modules exclusion reminder in the user content', () => {
    withTempCwd(() => {
      fs.mkdirSync(path.join(process.cwd(), 'node_modules'));
      const [user] = buildNodeModulesReminderMessages();
      expect(user.content).toContain('node_modules');
      expect(user.content).toContain('exclude');
      // Cross-platform guidance for both Unix and PowerShell should be present.
      expect(user.content).toContain('--exclude-dir=node_modules');
      expect(user.content).toContain('notmatch');
    });
  });

  it('mentions that the grep tool already auto-excludes node_modules', () => {
    withTempCwd(() => {
      fs.mkdirSync(path.join(process.cwd(), 'node_modules'));
      const [user] = buildNodeModulesReminderMessages();
      expect(user.content).toContain('grep tool already auto-excludes');
    });
  });
});
