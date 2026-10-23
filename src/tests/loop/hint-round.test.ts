/**
 * hint-round.test.ts — Tests for HintRoundManager.generate() and the
 * hint-round JSON output format.
 *
 * The hint-round feature (triologue/hint-round.ts) asks the LLM (via
 * retryChat) to produce a structured JSON analysis of the agent's current
 * blocker, then injects a formatted [HINT] note into the conversation.
 *
 * OWNERSHIP CHANGE: the manager is no longer a Triologue facade method
 * (Triologue.generateHintRound() is deleted). It is constructed by its
 * composition root — HintSuggester in states/collect-hint.ts — which holds
 * both the triologue and `ctx`. This test therefore drives the
 * HintRoundManager DIRECTLY, with the same deps the composition root supplies:
 * a live message provider, a note injector, and the wiki module.
 *
 * These tests drive the REAL HintRoundManager with a mocked retryChat to
 * verify:
 *   - 'success' path: valid JSON → HINT note injected with all fields
 *   - the executed wiki pre-filter: a kept line names the SNAPPED real domain,
 *     a zero-hit/error proposal is muted, and a missing wiki module passes the
 *     line through
 *   - 'aborted' path: abortController aborted → returns 'aborted'
 *   - retry on malformed JSON / missing required fields
 *   - wiki domains are included in the analysis prompt
 *   - pending skills are surfaced in the HINT note
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message, WikiModule } from '../../types.js';

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
import {
  HintRoundManager,
  type HintRoundManagerDeps,
} from '../../loop/triologue/hint-round.js';
import { retryChat } from '../../engine/chat-provider.js';

/** Build a valid hint JSON response (all required fields present). */
function validHintResponse(overrides: Record<string, unknown> = {}) {
  return {
    message: {
      content: JSON.stringify({
        blocker: 'Agent is stuck on a syntax error',
        next_step: 'Review the intent-language vocabulary',
        focus_on: 'intent-language syntax',
        wiki_domain: 'architecture',
        wiki_query: 'intent language verb object',
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

/** A wiki hit shaped like a real SearchResult (only the fields under test). */
function wikiHit(domain: string) {
  return { document: { domain }, similarity: 0.8, hash: 'h' };
}

/**
 * Build a fake WikiModule. `listDomains` returns the two registered domains
 * unless overridden; `get` returns no hits by default so individual tests set
 * their own pre-filter outcome.
 */
function makeWiki(overrides: Record<string, unknown> = {}): WikiModule {
  return {
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
    get: vi.fn(async () => []),
    delete: vi.fn(),
    getWAL: vi.fn(),
    appendWAL: vi.fn(),
    rebuild: vi.fn(),
    getDomain: vi.fn(),
    registerDomain: vi.fn(),
    ...overrides,
  } as unknown as WikiModule;
}

/**
 * Build a HintRoundManager wired exactly like the composition root
 * (HintSuggester.getManager): a live message array as the provider and a note
 * injector that appends `[<category>] <message>` user messages (so tests can
 * inspect the injected [HINT] note from the array).
 */
function makeManager(wiki?: WikiModule): {
  manager: HintRoundManager;
  messages: Message[];
  deps: HintRoundManagerDeps;
} {
  const messages: Message[] = [];
  const deps: HintRoundManagerDeps = {
    getMessagesRaw: () => messages,
    note: (category, message) => {
      messages.push({ role: 'user', content: `[${category}] ${message}` } as Message);
    },
    ...(wiki ? { wiki } : {}),
  };
  return { manager: new HintRoundManager(deps), messages, deps };
}

/** Find the injected [HINT] note in the message array. */
function findHint(messages: Message[]): Message | undefined {
  return messages.find((m) => m.content?.startsWith('[HINT]'));
}

describe('Hint Round JSON Output', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // success path
  // ---------------------------------------------------------------------------

  it('injects a [HINT] note when the LLM returns valid JSON', async () => {
    vi.mocked(retryChat).mockResolvedValueOnce(validHintResponse() as never);
    // The guessed domain ('architecture', from the fixture) is registered, so
    // the pre-filter searches it and snaps the emitted line to the TOP HIT's
    // real domain. Make the hit domain differ from the guess ('pitfall') so
    // this assertion FAILS if the pre-filter is removed: only the executed
    // search + snap can turn the guessed 'architecture' into 'pitfall'.
    const { manager, messages } = makeManager(
      makeWiki({ get: vi.fn(async () => [wikiHit('pitfall')]) }),
    );

    const result = await manager.generate(new AbortController(), 12, 'confusion breakdown');

    expect(result).toEqual({ status: 'success', focusOn: 'intent-language syntax' });
    // The HINT note was injected as a user message with the [HINT] prefix.
    const hintMsg = findHint(messages);
    expect(hintMsg).toBeDefined();
    expect(hintMsg!.content).toContain('**Blocker:** Agent is stuck on a syntax error');
    expect(hintMsg!.content).toContain('**Next Step:** Review the intent-language vocabulary');
    expect(hintMsg!.content).toContain('**Focus On:** intent-language syntax');
    // Imperative pre-filtered wiki line — the domain is the SNAPPED real one
    // from the executed search, NOT the guessed 'architecture'.
    expect(hintMsg!.content).toContain(
      '**Wiki Search:** call `wiki_get(domain="pitfall", query="intent language verb object")` to check the knowledge base for background on this blocker.',
    );
    expect(hintMsg!.content).not.toContain('domain="architecture"');
  });

  it('includes the confusion score and breakdown in the analysis prompt', async () => {
    vi.mocked(retryChat).mockResolvedValueOnce(validHintResponse() as never);
    const { manager } = makeManager(makeWiki());

    await manager.generate(new AbortController(), 15, 'repeated edit_file failures');

    expect(retryChat).toHaveBeenCalledTimes(1);
    const userPrompt = getUserPrompt();
    expect(userPrompt).toContain('## Confusion Score: 15');
    expect(userPrompt).toContain('repeated edit_file failures');
  });

  it('includes available wiki domains in the analysis prompt', async () => {
    vi.mocked(retryChat).mockResolvedValueOnce(validHintResponse() as never);
    const { manager } = makeManager(makeWiki());

    await manager.generate(new AbortController(), 10, 'breakdown');

    const userPrompt = getUserPrompt();
    expect(userPrompt).toContain('- architecture: System architecture and design patterns');
    expect(userPrompt).toContain('- api: API documentation and endpoints');
  });

  it('surfaces pending skills in the HINT note', async () => {
    vi.mocked(retryChat).mockResolvedValueOnce(validHintResponse() as never);
    const { manager, messages } = makeManager(
      makeWiki({ get: vi.fn(async () => [wikiHit('architecture')]) }),
    );

    await manager.generate(new AbortController(), 10, 'breakdown', [
      'my-skill',
      'other-skill',
    ]);

    const hintMsg = findHint(messages);
    expect(hintMsg).toBeDefined();
    expect(hintMsg!.content).toContain("**Also:** 'my-skill', 'other-skill' need compiling via `skill_compile`");
  });

  it('omits the wiki search line when wiki_domain is empty', async () => {
    // wiki_domain is allowed to be empty (blocker may be pure code logic);
    // wiki_query must stay non-empty (validation rejects empty). So only
    // empty wiki_domain drives the omitted-field branch — no filler line.
    vi.mocked(retryChat).mockResolvedValueOnce(
      validHintResponse({ wiki_domain: '' }) as never,
    );
    const { manager, messages } = makeManager(makeWiki());

    await manager.generate(new AbortController(), 10, 'breakdown');

    const hintMsg = findHint(messages);
    expect(hintMsg).toBeDefined();
    expect(hintMsg!.content).not.toContain('**Wiki Search:**');
    expect(hintMsg!.content).not.toContain('Domain=');
  });

  // ---------------------------------------------------------------------------
  // wiki pre-filter (executed semantic search before the line is surfaced)
  // ---------------------------------------------------------------------------

  it('mutes the wiki line when the pre-filter finds no hit (both fields cleared)', async () => {
    vi.mocked(retryChat).mockResolvedValueOnce(validHintResponse() as never);
    const get = vi.fn(async () => []);
    const { manager, messages } = makeManager(makeWiki({ get }));

    const result = await manager.generate(new AbortController(), 10, 'breakdown');

    // Registered domain search finds nothing, then the all-domains fallback
    // finds nothing → both fields cleared → no line, but the hint still lands.
    expect(get).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ status: 'success', focusOn: 'intent-language syntax' });
    const hintMsg = findHint(messages);
    expect(hintMsg).toBeDefined();
    expect(hintMsg!.content).not.toContain('**Wiki Search:**');
    expect(hintMsg!.content).toContain('**Blocker:**');
  });

  it('mutes the wiki line when the pre-filter search throws (hint still succeeds)', async () => {
    vi.mocked(retryChat).mockResolvedValueOnce(validHintResponse() as never);
    const get = vi.fn(async () => {
      throw new Error('wiki unavailable');
    });
    const { manager, messages } = makeManager(makeWiki({ get }));

    const result = await manager.generate(new AbortController(), 10, 'breakdown');

    expect(result).toEqual({ status: 'success', focusOn: 'intent-language syntax' });
    const hintMsg = findHint(messages);
    expect(hintMsg).toBeDefined();
    expect(hintMsg!.content).not.toContain('**Wiki Search:**');
  });

  it('snaps an unregistered guessed domain to the fallback hit domain and keeps the line', async () => {
    vi.mocked(retryChat).mockResolvedValueOnce(
      validHintResponse({ wiki_domain: 'project' }) as never,
    );
    // 'project' is not in the registered set → the domain search is skipped and
    // the all-domains fallback runs, hitting a real 'architecture' document.
    const get = vi.fn(async () => [wikiHit('architecture')]);
    const { manager, messages } = makeManager(makeWiki({ get }));

    const result = await manager.generate(new AbortController(), 10, 'breakdown');

    expect(get).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: 'success', focusOn: 'intent-language syntax' });
    const hintMsg = findHint(messages);
    expect(hintMsg).toBeDefined();
    expect(hintMsg!.content).toContain('**Wiki Search:**');
    expect(hintMsg!.content).toContain('domain="architecture"');
    expect(hintMsg!.content).not.toContain('domain="project"');
  });

  it('passes the wiki line through unchanged when no wiki module is wired', async () => {
    vi.mocked(retryChat).mockResolvedValueOnce(
      validHintResponse({ wiki_domain: 'project' }) as never,
    );
    const { manager, messages } = makeManager(undefined);

    const result = await manager.generate(new AbortController(), 10, 'breakdown');

    expect(result).toEqual({ status: 'success', focusOn: 'intent-language syntax' });
    const hintMsg = findHint(messages);
    expect(hintMsg).toBeDefined();
    expect(hintMsg!.content).toContain('domain="project"');
    expect(hintMsg!.content).toContain('**Wiki Search:**');
  });

  // ---------------------------------------------------------------------------
  // the hint round never signals compaction
  // ---------------------------------------------------------------------------
  // should_compact is GONE: the hint round always injects its [HINT] note and
  // never returns a 'compact' signal. Compaction is owned by token-based
  // auto-compact (TOKEN_THRESHOLD) and the hook-driven deferredCompact path —
  // never by hint analysis.

  it('injects the [HINT] note and returns success (never a compact signal)', async () => {
    vi.mocked(retryChat).mockResolvedValueOnce(
      validHintResponse({ blocker: 'Agent is looping on a failing test' }) as never,
    );
    const { manager, messages } = makeManager(makeWiki());

    const result = await manager.generate(new AbortController(), 10, 'breakdown');

    expect(result).toEqual({ status: 'success', focusOn: 'intent-language syntax' });
    expect(result).not.toBe('compact');
    expect(findHint(messages)).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // "no blockers" note injection (the note is NEVER silently suppressed)
  // ---------------------------------------------------------------------------
  // The hint-round always injects a [HINT] note (there is no suppressing
  // branch), INCLUDING the "no blockers" case. Suppressing the note on
  // "no blockers"
  // was a hazard: it swallowed genuinely valuable guidance (e.g. EXAMPLE D's
  // batch-encouragement coaching, which carries blocker:"no blockers") just
  // because the blocker label was the magic string "no blockers". The
  // anti-auto-progression concern that motivated the old suppression is now
  // handled in the PROMPT: instruction #2 and EXAMPLE C forbid framing
  // next_step as a "Continue ..." authorization. These tests lock in that the
  // note is always injected (no silent no-op), so a regression that re-adds
  // the suppression is caught.
  // ---------------------------------------------------------------------------

  it('injects the [HINT] note when blocker is "no blockers" (note is never silently suppressed)', async () => {
    vi.mocked(retryChat).mockResolvedValueOnce(
      validHintResponse({
        blocker: 'no blockers',
        next_step: 'The remaining work is completing test coverage for the compact module',
        focus_on: 'completing test coverage',
      }) as never,
    );
    const { manager, messages } = makeManager(
      makeWiki({ get: vi.fn(async () => [wikiHit('architecture')]) }),
    );

    const result = await manager.generate(new AbortController(), 10, 'breakdown');

    // focusOn is still returned so the composite keyword-extraction Z-source
    // in collect.ts keeps working.
    expect(result).toEqual({ status: 'success', focusOn: 'completing test coverage' });
    // The [HINT] note IS injected — "no blockers" is no longer a silent no-op.
    // This is the key inversion of the old suppression behavior.
    const hintMsg = findHint(messages);
    expect(hintMsg).toBeDefined();
    expect(hintMsg!.content).toContain('**Blocker:** no blockers');
    expect(hintMsg!.content).toContain('**Next Step:** The remaining work is completing test coverage for the compact module');
    expect(hintMsg!.content).toContain('**Focus On:** completing test coverage');
  });

  it('still injects the [HINT] note for a real (non-"no blockers") blocker', async () => {
    // Guard: a blocker that merely contains the word "no" (but is not the
    // literal "no blockers") injects the note just like any real blocker.
    vi.mocked(retryChat).mockResolvedValueOnce(
      validHintResponse({ blocker: 'no such file: config.json' }) as never,
    );
    const { manager, messages } = makeManager(
      makeWiki({ get: vi.fn(async () => [wikiHit('architecture')]) }),
    );

    const result = await manager.generate(new AbortController(), 10, 'breakdown');

    // Narrow the discriminated union: only the { status, focusOn } variant
    // carries .status. The 'aborted'/'failed' string variants do not, so
    // accessing result.status directly is a TS error on the union.
    expect(result).not.toBe('aborted');
    expect(result).not.toBe('failed');
    if (typeof result === 'object') {
      expect(result.status).toBe('success');
    }
    expect(findHint(messages)).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // aborted path
  // ---------------------------------------------------------------------------

  it('returns "aborted" when the abort controller is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const { manager } = makeManager(makeWiki());

    const result = await manager.generate(ac, 10, 'breakdown');

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
    const { manager } = makeManager(
      makeWiki({ get: vi.fn(async () => [wikiHit('architecture')]) }),
    );

    const result = await manager.generate(new AbortController(), 10, 'breakdown');

    expect(result).toEqual({ status: 'success', focusOn: 'intent-language syntax' });
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
          }),
        },
      } as never)
      .mockResolvedValueOnce(validHintResponse() as never);
    const { manager } = makeManager(
      makeWiki({ get: vi.fn(async () => [wikiHit('architecture')]) }),
    );

    const result = await manager.generate(new AbortController(), 10, 'breakdown');

    expect(result).toEqual({ status: 'success', focusOn: 'intent-language syntax' });
    expect(retryChat).toHaveBeenCalledTimes(2);
  });

  it('retries when the LLM returns an empty string (falls back to "{}")', async () => {
    vi.mocked(retryChat)
      .mockResolvedValueOnce({ message: { content: '' } } as never)
      .mockResolvedValueOnce(validHintResponse() as never);
    const { manager } = makeManager(
      makeWiki({ get: vi.fn(async () => [wikiHit('architecture')]) }),
    );

    const result = await manager.generate(new AbortController(), 10, 'breakdown');

    expect(result).toEqual({ status: 'success', focusOn: 'intent-language syntax' });
    expect(retryChat).toHaveBeenCalledTimes(2);
  });

  it('stops after the bounded retry budget when every hint response is malformed', async () => {
    vi.mocked(retryChat).mockImplementation(async () => ({
      message: { content: 'not json at all' },
    }) as never);
    const { manager, messages } = makeManager(makeWiki());

    const result = await manager.generate(new AbortController(), 10, 'breakdown');

    expect(result).toBe('failed');
    expect(retryChat).toHaveBeenCalledTimes(3);
    expect(findHint(messages)).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // focus_on exposure (Z source for composite keyword extraction)
  // ---------------------------------------------------------------------------

  it('exposes focus_on in the success return value', async () => {
    vi.mocked(retryChat).mockResolvedValueOnce(
      validHintResponse({ focus_on: 'finding the auto-mode activation handler' }) as never,
    );
    const { manager } = makeManager(
      makeWiki({ get: vi.fn(async () => [wikiHit('architecture')]) }),
    );

    const result = await manager.generate(new AbortController(), 10, 'breakdown');

    expect(result).toEqual({ status: 'success', focusOn: 'finding the auto-mode activation handler' });
  });

  it('exposes focusOn only on the success path', async () => {
    vi.mocked(retryChat).mockResolvedValueOnce(validHintResponse() as never);
    const { manager } = makeManager(makeWiki());

    const result = await manager.generate(new AbortController(), 10, 'breakdown');

    expect(result).toEqual({ status: 'success', focusOn: 'intent-language syntax' });
    expect(result).toHaveProperty('focusOn');
  });

  // ---------------------------------------------------------------------------
  // wiki domain handling
  // ---------------------------------------------------------------------------

  it('handles domains without descriptions', async () => {
    const wikiWithNoDescriptions = makeWiki({
      listDomains: vi.fn(async () => [
        {
          domain_name: 'project',
          description: '',
          created_at: '2026-01-01',
          project_folder: '/test',
        },
      ]),
    });
    vi.mocked(retryChat).mockResolvedValueOnce(validHintResponse() as never);
    const { manager } = makeManager(wikiWithNoDescriptions);

    await manager.generate(new AbortController(), 10, 'breakdown');

    const userPrompt = getUserPrompt();
    // Empty description → just the domain name, no colon suffix.
    expect(userPrompt).toContain('- project');
    expect(userPrompt).not.toContain('- project:');
  });

  it('handles empty domains list', async () => {
    const wikiEmpty = makeWiki({ listDomains: vi.fn(async () => []) });
    vi.mocked(retryChat).mockResolvedValueOnce(validHintResponse() as never);
    const { manager } = makeManager(wikiEmpty);

    await manager.generate(new AbortController(), 10, 'breakdown');

    const userPrompt = getUserPrompt();
    expect(userPrompt).toContain('No domains available');
  });
});
