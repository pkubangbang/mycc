import { describe, expect, it, vi } from 'vitest';
import { buildSummaryPrompt, type CompactDeps } from '../../loop/triologue/compact.js';

function makeDeps(lastUserQuery: string): CompactDeps {
  return {
    getRawMessages: () => [],
    getFullMessages: () => [],
    lastUserQuery: () => lastUserQuery,
    onCompact: vi.fn(),
  };
}

describe('buildSummaryPrompt', () => {
  it('includes wiki guidance, focus, last user constraints, and the conversation', () => {
    const prompt = buildSummaryPrompt(
      'CONVERSATION BODY',
      makeDeps('Preserve the exact API contract'),
      [{ domain_name: 'project', description: 'project-specific knowledge' }],
      'TP parity',
    );

    expect(prompt).toContain('### 1) What Was Accomplished');
    expect(prompt).toContain('### 2) Current State');
    expect(prompt).toContain('### 3) Key Decisions Made');
    expect(prompt).toContain('- project: project-specific knowledge');
    expect(prompt).toContain('**Focus Area:** Pay special attention to information related to "TP parity"');
    expect(prompt).toContain('**User\'s Last Instruction:** "Preserve the exact API contract"');
    expect(prompt.endsWith('CONVERSATION BODY')).toBe(true);
  });

  it('omits optional wiki, focus, and last-query sections when absent', () => {
    const prompt = buildSummaryPrompt('BODY', makeDeps(''), []);

    expect(prompt).not.toContain('### Knowledge Persistence');
    expect(prompt).not.toContain('**Focus Area:**');
    expect(prompt).not.toContain('**User\'s Last Instruction:**');
    expect(prompt.endsWith('BODY')).toBe(true);
  });
});
