/**
 * brief-recap-scope.test.ts
 *
 * Guards the SCOPE of the brief / folding teaching.
 *
 * THE BUG THIS PINS DOWN, in its post-auto-recap shape: `brief` is
 * `scope: ['main', 'child']`, so its description travels to EVERY teammate —
 * and a teammate's span is never folded (the fold runs at HOOK step 4a, lead
 * only). The old test guarded a `recap` TOOL; that tool is gone. The contract
 * that survives is the same contract in a different place: the fold is taught
 * ONCE, in buildBriefRecapSection(), reachable only via
 * buildLeadAgentMemorySection(), and nowhere a teammate can read.
 *
 * It also pins the vocabulary itself: with no `recap` tool and no
 * model-addressable anchor, no model-facing surface may mention `recap`,
 * "rewind", or an "anchor" — those words name a capability the model does not
 * have, and an affordance the model cannot use costs a round-trip when it
 * tries.
 */
import { describe, it, expect } from 'vitest';

import { briefTool } from '../../../tools/brief.js';
import {
  buildBriefRecapSection,
  buildLeadAgentMemorySection,
  buildTeammateAgentMemorySection,
} from '../../../loop/prompts/common.js';

/** The vocabulary a model-facing surface must not carry any more. */
const RETIRED_CALL = /recap\(|target_brief|rewind|\banchor\b/i;

describe('brief tool description stays a plain reporter', () => {
  it('brief is shared with teammates (the reason this matters)', () => {
    expect(briefTool.scope).toContain('child');
  });

  it('mentions no recap / rewind-anchor wording', () => {
    expect(briefTool.description).not.toMatch(RETIRED_CALL);
  });

  it('still states the isolation rule, which is enforced for every caller', () => {
    expect(briefTool.description).toContain('Must be called alone');
  });
});

describe('the fold is taught only in the lead section', () => {
  it('the lead section describes folding and its note', () => {
    const section = buildBriefRecapSection();
    expect(section).toMatch(/fold/i);
    expect(section).toContain('[RECAP]');
  });

  it('and it tells the model it does NOT choose when to fold', () => {
    expect(buildBriefRecapSection()).toMatch(/do not choose/i);
  });

  it('it carries no call the model could make', () => {
    expect(buildBriefRecapSection()).not.toMatch(RETIRED_CALL);
  });

  it('the lead agent-memory section includes it', () => {
    expect(buildLeadAgentMemorySection()).toContain(buildBriefRecapSection());
  });
});

describe('teammates never see the fold contract', () => {
  it('the teammate agent-memory section omits it', () => {
    const section = buildTeammateAgentMemorySection();
    expect(section).not.toContain(buildBriefRecapSection());
    expect(section).not.toContain('[RECAP]');
    expect(section).not.toMatch(/do not choose/i);
  });
});
