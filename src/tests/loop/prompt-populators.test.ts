/**
 * prompt-populators.test.ts
 *
 * Unit test for buildPlatformCalendarMessages() in src/loop/prompt-populators.ts.
 *
 * These (## Platform, ## Calendar) sections used to be inlined into the system
 * prompt (agent-prompts.ts buildCommonSections/buildPlanBasePrompt) — rebuilt on
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
import { buildPlatformCalendarMessages } from '../../loop/prompt-populators.js';

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
