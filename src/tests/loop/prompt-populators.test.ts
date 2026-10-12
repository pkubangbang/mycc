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
import { buildPlatformCalendarMessages, buildNodeModulesReminderMessages, buildWikiDomainsMessages, buildCollaborationMessages } from '../../loop/prompt-populators.js';

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

describe('buildWikiDomainsMessages', () => {
  it('returns an empty array when there are no domains', () => {
    const messages = buildWikiDomainsMessages([]);
    expect(messages).toEqual([]);
  });

  it('returns a user + assistant pair listing every domain name and description', () => {
    const messages = buildWikiDomainsMessages([
      { domain_name: 'pitfall', description: 'known traps and how to avoid them' },
      { domain_name: 'routine', description: 'repeatable procedures' },
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[1].role).toBe('assistant');

    const [user] = messages;
    expect(user.content).toContain('[System - Wiki Domains]');
    expect(user.content).toContain('pitfall');
    expect(user.content).toContain('known traps and how to avoid them');
    expect(user.content).toContain('routine');
    expect(user.content).toContain('repeatable procedures');
  });

  it('emits no trailing colon for a domain with an empty description', () => {
    const [user] = buildWikiDomainsMessages([
      { domain_name: 'bare', description: '' },
      { domain_name: 'described', description: 'has a description' },
    ]);
    expect(user.content).toContain('- bare\n');
    expect(user.content).not.toContain('- bare:');
    expect(user.content).toContain('- described: has a description');
  });
});

describe('buildCollaborationMessages', () => {
  it('returns a user + assistant message pair', () => {
    const messages = buildCollaborationMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[1].role).toBe('assistant');
  });

  it('names all four collaboration mechanisms in the user content', () => {
    const [user] = buildCollaborationMessages();
    expect(user.content).toContain('[System - Collaboration Mechanisms]');
    expect(user.content).toContain('Teammate (same-session)');
    expect(user.content).toContain('Peer (cross-session, LOCAL)');
    expect(user.content).toContain('Remote (cross-machine, via webui)');
    expect(user.content).toContain('Compose (most complex, via a topology FILE)');
  });

  it('references the governing skill for each mechanism', () => {
    const [user] = buildCollaborationMessages();
    expect(user.content).toContain('coordination');
    expect(user.content).toContain('mediator');
    expect(user.content).toContain('mycc-compose');
  });

  it('identifies teammate spawn and peer/remote/compose tools', () => {
    const [user] = buildCollaborationMessages();
    expect(user.content).toContain('tm_create');
    expect(user.content).toContain('peer_connect');
    expect(user.content).toContain('mail_to');
    expect(user.content).toContain('session-id');
  });

  it('is byte-stable across invocations (no dynamic content)', () => {
    expect(buildCollaborationMessages()).toEqual(buildCollaborationMessages());
  });
});
