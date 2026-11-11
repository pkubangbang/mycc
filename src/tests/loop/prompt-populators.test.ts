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

import { describe, it, expect } from 'vite-plus/test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  buildPlatformCalendarMessages,
  buildNodeModulesReminderMessages,
  buildWikiDomainsMessages,
  buildCollaborationMessages,
  buildProjectDocMessages,
  resolveProjectDoc
} from '../../loop/prompt-populators.js';

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
      { domain_name: 'routine', description: 'repeatable procedures' }
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
      { domain_name: 'described', description: 'has a description' }
    ]);
    expect(user.content).toContain('- bare\n');
    expect(user.content).not.toContain('- bare:');
    expect(user.content).toContain('- described: has a description');
  });
});

describe('buildProjectDocMessages', () => {
  // Run a callback with cwd set to a scratch temp dir (restored afterwards).
  function inTempDir<T>(fn: (dir: string) => T): T {
    const originalCwd = process.cwd();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-doc-populator-test-'));
    process.chdir(tmpDir);
    try {
      return fn(tmpDir);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  it('returns an empty array when the doc is absent', () => {
    inTempDir(() => {
      expect(buildProjectDocMessages({ fileName: 'AGENTS.md' })).toEqual([]);
    });
  });

  it('resolves AGENTS.md, the STANDARD spelling', () => {
    inTempDir((dir) => {
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Rulebook\n\n## Output Behavior\nbe brief\n');
      const resolved = resolveProjectDoc(dir, 'AGENTS.md');
      expect(resolved).toEqual({ path: path.join(dir, 'AGENTS.md'), legacy: false });
    });
  });

  it('reads AGENT.md as a DEPRECATED FALLBACK with a warning', () => {
    inTempDir((dir) => {
      fs.writeFileSync(path.join(dir, 'AGENT.md'), '# Rulebook\n\n## Output Behavior\nbe brief\n');
      const briefs: [string, string, string][] = [];
      const [user] = buildProjectDocMessages({
        fileName: 'AGENTS.md',
        log: { brief: (level, tool, message) => briefs.push([level, tool, message]) }
      });
      // It still loads — a project on the old spelling is not broken…
      expect(user.content).toContain('[Project Context - AGENT.md from project root, FYI]');
      // …but it is never silent: the reader is told to rename it.
      expect(briefs).toHaveLength(1);
      expect(briefs[0][0]).toBe('warn');
      expect(briefs[0][2]).toContain('DEPRECATED');
      expect(briefs[0][2]).toContain('rename');
      expect(briefs[0][2]).toContain('AGENTS.md');
    });
  });

  it('prefers the STANDARD name when BOTH spellings exist, and ignores the legacy one', () => {
    inTempDir((dir) => {
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Canonical\ncanonical rules\n');
      fs.writeFileSync(path.join(dir, 'AGENT.md'), '# Legacy\nlegacy rules\n');
      const briefs: string[] = [];
      const [user] = buildProjectDocMessages({
        fileName: 'AGENTS.md',
        log: { brief: (_l, _t, m) => briefs.push(m) }
      });
      expect(user.content).toContain('canonical rules');
      expect(user.content).not.toContain('legacy rules');
      // No warning: the standard file is present, so nothing deprecated was read.
      expect(briefs).toEqual([]);
    });
  });

  it('emits NO warning when the standard file is the only one', () => {
    inTempDir((dir) => {
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Rulebook\n');
      const briefs: string[] = [];
      buildProjectDocMessages({ fileName: 'AGENTS.md', log: { brief: (_l, _t, m) => briefs.push(m) } });
      expect(briefs).toEqual([]);
    });
  });

  it('resolves case-insensitively (agents.md request → the AGENTS.md file)', () => {
    inTempDir((dir) => {
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Rulebook\n');
      const resolved = resolveProjectDoc(dir, 'agents.md');
      expect(resolved).not.toBeNull();
      // The resolved path must point at the ONE physical file, whichever case
      // the caller used and whichever case the OS reports back (Windows is
      // case-insensitive, Linux CI is not — compare case-insensitively).
      expect(path.basename(resolved?.path as string).toLowerCase()).toBe('agents.md');
      expect(fs.readFileSync(resolved?.path as string, 'utf-8')).toBe('# Rulebook\n');
      expect(resolved?.legacy).toBe(false);
    });
  });

  it('returns null when no spelling of the doc exists', () => {
    inTempDir((dir) => {
      expect(resolveProjectDoc(dir, 'AGENT.md')).toBeNull();
      expect(resolveProjectDoc(dir, 'AGENTS.md')).toBeNull();
      expect(buildProjectDocMessages({ fileName: 'AGENTS.md' })).toEqual([]);
    });
  });

  it('labels the injected context with the RESOLVED file name, not the requested one', () => {
    inTempDir((dir) => {
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Rulebook\n\n## Output Behavior\nbe brief\n');
      const [user, ack] = buildProjectDocMessages({ fileName: 'AGENTS.md' });
      expect(user.content).toContain('[Project Context - AGENTS.md from project root, FYI]');
      expect(user.content).toContain('## Output Behavior');
      expect(ack.content).toContain('AGENTS.md');
      expect(ack.content).toContain('Rulebook');
    });
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
