/**
 * brief-recap-scope.test.ts
 *
 * Guards the SCOPE of the brief/recap teaching.
 *
 * The bug this test pins down: `brief` is `scope: ['main', 'child']`, so its
 * description travels to every teammate — and teammates may not call `recap`
 * (`recap.scope === ['main']`). The description used to explain that briefs
 * are recap rewind anchors, i.e. it taught a tool the reader cannot use and
 * told a child to write briefs "as your only surviving record", which is only
 * true for the lead. The recap contract now lives in two lead-only places:
 *
 *   1. the `recap` tool description (scope: main), and
 *   2. buildBriefRecapSection(), reachable only via buildLeadAgentMemorySection().
 *
 * These assertions fail if any future edit re-leaks recap into a surface a
 * teammate can see (the brief description, the shared common sections, or the
 * teammate prompt / agent-memory section).
 */

import { describe, it, expect } from 'vitest';

import { briefTool } from '../../../tools/brief.js';
import { recapTool } from '../../../tools/recap.js';
import {
  buildBriefRecapSection,
  buildCommonSections,
  buildLeadAgentMemorySection,
  buildTeammateAgentMemorySection,
} from '../../../loop/prompts/common.js';
import { buildTeammatePrompt } from '../../../loop/prompts/teammate.js';

const RECAP = /recap/i;

describe('brief tool description does not teach recap', () => {
  it('brief is shared with teammates (the reason this matters)', () => {
    expect(briefTool.scope).toContain('child');
  });

  it('mentions no recap / rewind-anchor wording', () => {
    expect(briefTool.description).not.toMatch(RECAP);
    expect(briefTool.description).not.toMatch(/rewind/i);
    expect(briefTool.description).not.toMatch(/anchor/i);
  });

  it('still states the isolation rule, which is enforced for every caller', () => {
    expect(briefTool.description).toContain('Must be called alone');
  });
});

describe('recap tool description stays lead-only', () => {
  it('recap scope is main-only', () => {
    expect(recapTool.scope).toEqual(['main']);
  });

  it('and it is where the tool-level contract is explained', () => {
    expect(recapTool.description).toMatch(/brief/i);
    expect(recapTool.description).toMatch(/anchor/i);
  });
});

describe('system prompt: recap guidance is lead-only', () => {
  it('lead agent-memory section carries the Briefs and Recap section', () => {
    const lead = buildLeadAgentMemorySection();
    expect(lead).toContain('## Briefs and Recap');
    expect(lead).toMatch(/rewind/i);
  });

  it('teammate agent-memory section does not mention recap', () => {
    expect(buildTeammateAgentMemorySection()).not.toMatch(RECAP);
  });

  it('shared common sections do not mention recap', () => {
    expect(buildCommonSections()).not.toMatch(RECAP);
  });

  it('the assembled teammate prompt does not mention recap', () => {
    const prompt = buildTeammatePrompt('/work', { name: 'w1', role: 'coder' });
    expect(prompt).not.toMatch(RECAP);
  });

  it('buildBriefRecapSection is self-contained and recap-only (no teammate path)', () => {
    const section = buildBriefRecapSection();
    expect(section).toContain('## Briefs and Recap');
    expect(section).toMatch(/only YOU \(the lead\)/i);
  });

  it('recap guidance teaches the two-field schema (target_brief + summary)', () => {
    const section = buildBriefRecapSection();
    // The always-on prompt must teach the CURRENT argument names — the ones
    // hook.ts actually reads — or the model copies a call that is refused.
    expect(section).toContain('target_brief="<hash>"');
    expect(section).toContain('summary="…"');
    // An empty summary is the discard request; there is no `abandon` flag.
    expect(section).toContain('summary: ""');
    // The anchor line the model reads and the argument it names must agree.
    expect(section).toContain('[<hash>] ANCHOR');
    expect(section).toMatch(/pops frames back/i);
    // The deleted API must never come back into the prompt.
    expect(section).not.toMatch(/abandon=true/);
    expect(section).not.toMatch(/target="<hash>"/);
    expect(section).not.toMatch(/\bcomment\b/);
    expect(section).not.toMatch(/description[=:]/);
    expect(section).not.toMatch(/pops the topmost frame/);
  });
});
