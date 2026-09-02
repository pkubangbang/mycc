/**
 * hint-round.test.ts — Tests for Triologue.generateHintRound() and the
 * hint-round JSON output format.
 *
 * The hint-round feature (triologue/hint-round.ts) asks the LLM (via
 * retryChat) to produce a structured JSON analysis of the agent's current
 * blocker, then injects a formatted [HINT] note into the conversation.
 * These tests drive the REAL Triologue facade with a mocked retryChat to
 * verify:
 *   - 'success' path: valid JSON → HINT note injected with all fields
 *   - 'compact' path: should_compact=true → returns 'compact', no note
 *   - 'aborted' path: abortController aborted → returns 'aborted'
 *   - retry on malformed JSON / missing required fields
 *   - wiki domains are included in the analysis prompt
 *   - pending skills are surfaced in the HINT note
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WikiModule } from '../../types.js';

// --- Mocks (paths relative to this test file: src/tests/loop/) --------------

vi.mock('../../engine/chat-provider.js', () => ({
  retryChat: vi.fn(),
  MODEL: 'test-model',
}));

vi.mock('../../loop/agent-io.js', () => ({
  agentIO: {
    verbose: vi.fn(),
    brief: vi.fn(),
    isNeglectedMode: vi.fn(() => false),
    setNeglectedMode: vi.fn(),
  },
}));

vi.mock('../../utils/llm-chat-minifier.js', () => ({
  minifyMessages: vi.fn(() => '[minified context]'),
}));

// --- Imports after mocks ----------------------------------------------------
import { Triologue } from '../../loop/triologue.js';
import { retryChat } from '../../engine/chat-provider.js';

/** Build a valid hint JSON response (all required fields present). */
function validHintResponse(overrides: Record<string, unknown> = {}) {
  return {
    message: {
      content: JSON.stringify({
        blocker: 'Agent is stuck on a syntax error',
        next_step: 'Review the intent-language vocabulary',
        focus_on: 'intent-language syntax',
        wiki_domain: 'project',
        wiki_query: 'intent language verb object',
        should_compact: false,
        ...overrides,
      }),
    },
  };
}

/** Extract the user prompt passed to retryChat (messages[1] is the user msg). */
function getUserPrompt(): string {
  const callArgs = vi.mocked(retryChat).mock.calls[0][0] as {
    messages: Array<{ role: string; content: string }>;
  };
  return callArgs.messages[1].content;
}

describe('Hint Round JSON Output', () => {
  let triologue: Triologue;
  let mockWiki: WikiModule;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWiki = {
      listDomains: vi.fn(async () => [
        {
          domain_name: 'architecture',
          description: 'System architecture and design patterns',
          created_at: '2026-01-01',
          project_folder: '/test',
        },
        {
          domain_name: 'api',
          description: 'API documentation and endpoints',
          created_at: '2026-01-01',
          project_folder: '/test',
        },
      ]),
      prepare: vi.fn(),
      put: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      getWAL: vi.fn(),
      parseWAL: vi.fn(),
      formatWAL: vi.fn(),
      appendWAL: vi.fn(),
      rebuild: vi.fn(),
      getDomain: vi.fn(),
      registerDomain: vi.fn(),
    } as unknown as WikiModule;

    triologue = new Triologue({
      getWikiDomains: async () => mockWiki.listDomains(),
      hintThreshold: 10,
    });
  });

  // ---------------------------------------------------------------------------
  // success path
  // ---------------------------------------------------------------------------

  it('injects a [HINT] note when the LLM returns valid JSON', async () => {
    vi.mocked(retryChat).mockResolvedValueOnce(validHintResponse() as never);

    const result = await triologue.generateHintRound(
      new AbortController(),
      12,
      'confusion breakdown',
    );

    expect(result).toBe('success');
    // The HINT note was injected as a user message with the [HINT] prefix.
    const messages = triologue.getMessagesRaw();
    const hintMsg = messages.find((m) => m.content?.startsWith('[HINT]'));
    expect(hintMsg).toBeDefined();
    expect(hintMsg!.content).toContain('**Blocker:** Agent is stuck on a syntax error');
    expect(hintMsg!.content).toContain('**Next Step:** Review the intent-language vocabulary');
    expect(hintMsg!.content).toContain('**Focus On:** intent-language syntax');
    expect(hintMsg!.content).toContain('**Wiki Search:** Domain="project", Query="intent language verb object"');
  });

  it('includes the confusion score and breakdown in the analysis prompt', async () => {
    vi.mocked(retryChat).mockResolvedValueOnce(validHintResponse() as never);

    await triologue.generateHintRound(
      new AbortController(),
      15,
      'repeated edit_file failures',
    );

    expect(retryChat).toHaveBeenCalledTimes(1);
    const userPrompt = getUserPrompt();
    expect(userPrompt).toContain('## Confusion Score: 15');
    expect(userPrompt).toContain('repeated edit_file failures');
  });

  it('includes available wiki domains in the analysis prompt', async () => {
    vi.mocked(retryChat).mockResolvedValueOnce(validHintResponse() as never);

    await triologue.generateHintRound(new AbortController(), 10, 'breakdown');

    const userPrompt = getUserPrompt();
    expect(userPrompt).toContain('- architecture: System architecture and design patterns');
    expect(userPrompt).toContain('- api: API documentation and endpoints');
  });

  it('surfaces pending skills in the HINT note', async () => {
    vi.mocked(retryChat).mockResolvedValueOnce(validHintResponse() as never);

    await triologue.generateHintRound(
      new AbortController(),
      10,
      'breakdown',
      ['my-skill', 'other-skill'],
    );

    const messages = triologue.getMessagesRaw();
    const hintMsg = messages.find((m) => m.content?.startsWith('[HINT]'));
    expect(hintMsg).toBeDefined();
    expect(hintMsg!.content).toContain("**Pending Skill Compilation:** 'my-skill', 'other-skill'");
    expect(hintMsg!.content).toContain('Use `skill_compile` to compile these skills');
  });

  it('omits the wiki search line when wiki_domain is empty', async () => {
    // wiki_domain is allowed to be empty (blocker may be pure code logic);
    // wiki_query must stay non-empty (validation rejects empty). So only
    // empty wiki_domain drives the "None" branch.
    vi.mocked(retryChat).mockResolvedValueOnce(
      validHintResponse({ wiki_domain: '' }) as never,
    );

    await triologue.generateHintRound(new AbortController(), 10, 'breakdown');

    const messages = triologue.getMessagesRaw();
    const hintMsg = messages.find((m) => m.content?.startsWith('[HINT]'));
    expect(hintMsg).toBeDefined();
    expect(hintMsg!.content).toContain('**Wiki Search:** None');
    expect(hintMsg!.content).not.toContain('Domain=');
  });

  // ---------------------------------------------------------------------------
  // compact path
  // ---------------------------------------------------------------------------

  it('returns "compact" (no HINT note) when should_compact is true', async () => {
    vi.mocked(retryChat).mockResolvedValueOnce(
      validHintResponse({ should_compact: true }) as never,
    );

    const result = await triologue.generateHintRound(new AbortController(), 10, 'breakdown');

    expect(result).toBe('compact');
    // No HINT note injected — compaction is the intervention.
    const messages = triologue.getMessagesRaw();
    expect(messages.find((m) => m.content?.startsWith('[HINT]'))).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // aborted path
  // ---------------------------------------------------------------------------

  it('returns "aborted" when the abort controller is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();

    const result = await triologue.generateHintRound(ac, 10, 'breakdown');

    expect(result).toBe('aborted');
    expect(retryChat).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // retry on malformed / invalid LLM output
  // ---------------------------------------------------------------------------

  it('retries when the LLM returns malformed JSON', async () => {
    vi.mocked(retryChat)
      .mockResolvedValueOnce({ message: { content: 'not json at all' } } as never)
      .mockResolvedValueOnce(validHintResponse() as never);

    const result = await triologue.generateHintRound(new AbortController(), 10, 'breakdown');

    expect(result).toBe('success');
    expect(retryChat).toHaveBeenCalledTimes(2);
  });

  it('retries when the LLM returns JSON missing required fields', async () => {
    // Missing next_step (and wiki_query) — validation must reject and retry.
    vi.mocked(retryChat)
      .mockResolvedValueOnce({
        message: {
          content: JSON.stringify({
            blocker: 'x',
            focus_on: 'y',
            wiki_domain: 'z',
            should_compact: false,
          }),
        },
      } as never)
      .mockResolvedValueOnce(validHintResponse() as never);

    const result = await triologue.generateHintRound(new AbortController(), 10, 'breakdown');

    expect(result).toBe('success');
    expect(retryChat).toHaveBeenCalledTimes(2);
  });

  it('retries when the LLM returns an empty string (falls back to "{}")', async () => {
    vi.mocked(retryChat)
      .mockResolvedValueOnce({ message: { content: '' } } as never)
      .mockResolvedValueOnce(validHintResponse() as never);

    const result = await triologue.generateHintRound(new AbortController(), 10, 'breakdown');

    expect(result).toBe('success');
    expect(retryChat).toHaveBeenCalledTimes(2);
  });

  // ---------------------------------------------------------------------------
  // wiki domain handling
  // ---------------------------------------------------------------------------

  it('handles domains without descriptions', async () => {
    const wikiWithNoDescriptions: WikiModule = {
      ...mockWiki,
      listDomains: vi.fn(async () => [
        {
          domain_name: 'project',
          description: '',
          created_at: '2026-01-01',
          project_folder: '/test',
        },
      ]),
    } as unknown as WikiModule;

    const triologue2 = new Triologue({
      getWikiDomains: async () => wikiWithNoDescriptions.listDomains(),
      hintThreshold: 10,
    });
    vi.mocked(retryChat).mockResolvedValueOnce(validHintResponse() as never);

    await triologue2.generateHintRound(new AbortController(), 10, 'breakdown');

    const userPrompt = getUserPrompt();
    // Empty description → just the domain name, no colon suffix.
    expect(userPrompt).toContain('- project');
    expect(userPrompt).not.toContain('- project:');
  });

  it('handles empty domains list', async () => {
    const wikiEmpty: WikiModule = {
      ...mockWiki,
      listDomains: vi.fn(async () => []),
    } as unknown as WikiModule;

    const triologue2 = new Triologue({
      getWikiDomains: async () => wikiEmpty.listDomains(),
      hintThreshold: 10,
    });
    vi.mocked(retryChat).mockResolvedValueOnce(validHintResponse() as never);

    await triologue2.generateHintRound(new AbortController(), 10, 'breakdown');

    const userPrompt = getUserPrompt();
    expect(userPrompt).toContain('No domains available');
  });
});
