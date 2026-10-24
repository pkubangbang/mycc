/**
 * hint-round.test.ts — Tests for the HintRound singleton and the hint-round
 * JSON output format.
 *
 * OWNERSHIP CHANGE: the feature is no longer split between HintSuggester
 * (states/collect-hint.ts) and a per-round HintRoundManager
 * (triologue/hint-round.ts). Both collapsed into the process-wide `hintRound`
 * singleton in loop/hint-round.ts, which receives the live MachineEnv through
 * `init(env)` and pushes its [HINT] note into `env.triologue`.
 *
 * These tests drive the REAL HintRound with a mocked retryChat to verify:
 *   - 'success' path: valid JSON → HINT note injected with all fields
 *   - the executed wiki pre-filter: a kept line names the SNAPPED real domain,
 *     a zero-hit/error proposal is muted, and a missing wiki module passes the
 *     line through
 *   - 'aborted' path: abortController aborted → 'stop'
 *   - retry on malformed JSON / missing required fields, bounded at 3 attempts
 *   - wiki domains are included in the analysis prompt
 *   - pending skills are surfaced in the HINT note
 *   - the gate (confusion + minimum message count) and the null-env guard
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
import { HintRound, hintRound, detectRepeatedActions } from '../../loop/hint-round.js';
import { retryChat } from '../../engine/chat-provider.js';
import { createMockMachineEnv, createTurnVars } from './esc-test-helpers.js';
import type { MachineEnv } from '../../loop/state-machine.js';

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

/** Message arrays recorded by the triologue double, keyed for assertions. */
interface Harness {
  round: HintRound;
  env: MachineEnv;
  messages: Message[];
  notes: Array<{ category: string; message: string }>;
}

/**
 * Harnesses created by the current test. The real HintRound binds to the env
 * instance it is handed, so a harness must stay alive for the whole test —
 * tests call `live(round)` to reach the harness bound to a singleton.
 */
const harnesses = new Map<HintRound, Harness>();

/** Resolve the harness bound to a round (or the process-wide singleton). */
function live(round: HintRound): Harness {
  const h = harnesses.get(round);
  if (!h) throw new Error('No harness bound to this HintRound — call makeHarness() first.');
  return h;
}

/**
 * Build a HintRound wired to a mock MachineEnv: the triologue double records
 * the injected notes AND appends them to `messages` (as `[<category>] …`), so
 * tests can inspect both the call and the resulting transcript.
 */
function makeHarness(options: {
  wiki?: WikiModule;
  messages?: Message[];
  confusionIndex?: number;
  /** When true, escAware is left un-overridden (the singleton's own escAware call fails loudly). */
  escAware?: MachineEnv['ctx']['core']['escAware'];
  duplicationReport?: string;
} = {}): Harness {
  const messages: Message[] = options.messages ? [...options.messages] : [];
  const notes: Array<{ category: string; message: string }> = [];

  const triologue = {
    getMessagesRaw: vi.fn(() => messages),
    note: vi.fn((category: string, message: string) => {
      notes.push({ category, message });
      messages.push({ role: 'user', content: `[${category}] ${message}` } as Message);
    }),
    getMessages: vi.fn(() => messages),
    compact: vi.fn(async () => {}),
    getTokenCount: vi.fn(() => 100),
    getTokenThreshold: vi.fn(() => 50000),
    getLastRole: vi.fn(() => null),
  };

  const DEFAULT_MESSAGES: Message[] = Array.from({ length: 8 }, (_, i) => ({
    role: i === 0 ? 'user' : 'assistant',
    content: i === 0 ? 'do the task' : 'working',
  } as Message));

  const env = createMockMachineEnv({
    triologue: triologue as never,
    ctxOptions: {
      core: {
        getConfusionIndex: vi.fn(() => options.confusionIndex ?? 12), // >= CONFUSION_THRESHOLD (10)
        resetConfusionIndex: vi.fn(),
        brief: vi.fn(),
        // Default escAware for the REAL ctx: run the operation, never ESC.
        escAware: vi.fn(async (fn: (ac: AbortController) => Promise<unknown>) => fn(new AbortController())),
      } as never,
      ...(options.wiki ? { wiki: options.wiki } : {}),
    },
    requestEmbeddingTracker: {
      getDuplicationReport: vi.fn(() => options.duplicationReport ?? ''),
    },
  });
  // The harness owns the message stream: >= MIN_MESSAGES_FOR_HINT (6) by default,
  // so the singleton's gate opens unless a test says otherwise.
  const seed = options.messages ? [...options.messages] : [...DEFAULT_MESSAGES];
  for (const m of seed) messages.push(m);
  triologue.getMessagesRaw.mockImplementation(() => messages);
  if (options.escAware) {
    env.ctx.core.escAware = options.escAware;
  }

  const round = new HintRound();
  round.init(env);
  const harness: Harness = { round, env, messages, notes };
  harnesses.set(round, harness);
  return harness;
}

/** Find the injected [HINT] note in the message array. */
function findHint(messages: Message[]): Message | undefined {
  return messages.find((m) => m.content?.startsWith('[HINT]'));
}

describe('Hint Round JSON Output', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    hintRound.reset();
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
    const { round, env, messages } = makeHarness({
      wiki: makeWiki({ get: vi.fn(async () => [wikiHit('pitfall')]) }),
    });

    const signal = await round.run(createTurnVars());

    expect(signal).toBe('continue');
    // The HINT note was pushed into the triologue as a user message.
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
    // The confusion signal is cleared only after a hint actually landed.
    expect(env.ctx.core.resetConfusionIndex).toHaveBeenCalledTimes(1);
  });

  it('captures focus_on on the turn after a successful hint round', async () => {
    vi.mocked(retryChat).mockResolvedValueOnce(validHintResponse() as never);
    const { round } = makeHarness({
      wiki: makeWiki({ get: vi.fn(async () => [wikiHit('architecture')]) }),
    });
    const turn = createTurnVars();

    await round.run(turn);

    expect(turn.lastHintFocus).toBe('intent-language syntax');
  });

  it('includes the confusion score and breakdown in the analysis prompt', async () => {
    vi.mocked(retryChat).mockResolvedValueOnce(validHintResponse() as never);
    const { round } = makeHarness({
      wiki: makeWiki(),
      confusionIndex: 15,
    });

    await round.run(createTurnVars());

    expect(retryChat).toHaveBeenCalledTimes(1);
    const userPrompt = getUserPrompt();
    expect(userPrompt).toContain('## Confusion Score: 15');
    // No dead-loop evidence in an empty turn -> the neutral breakdown line.
    expect(userPrompt).toContain('No issues detected');
  });

  it('feeds repeated-action evidence from the sequence into the prompt', async () => {
    vi.mocked(retryChat).mockResolvedValueOnce(validHintResponse() as never);
    const repeatedEvents = Array.from({ length: 4 }, () => ({
      tool: 'edit_file',
      args: { path: 'a.ts' },
      result: 'Error: old_text not found in file',
      timestamp: Date.now(),
    }));
    const { round, env } = makeHarness({ wiki: makeWiki() });
    env.sequence.getEvents = vi.fn(() => repeatedEvents) as never;

    await round.run(createTurnVars());

    expect(getUserPrompt()).toContain('Repeated actions: edit_file ×4');
  });

  it('includes available wiki domains in the analysis prompt', async () => {
    vi.mocked(retryChat).mockResolvedValueOnce(validHintResponse() as never);
    const { round } = makeHarness({ wiki: makeWiki() });

    await round.run(createTurnVars());

    const userPrompt = getUserPrompt();
    expect(userPrompt).toContain('- architecture: System architecture and design patterns');
    expect(userPrompt).toContain('- api: API documentation and endpoints');
  });

  it('threads the embedding tracker duplication report into the prompt', async () => {
    vi.mocked(retryChat).mockResolvedValueOnce(validHintResponse() as never);
    const { round } = makeHarness({
      wiki: makeWiki(),
      duplicationReport: 'Semantic Duplication Analysis:\n  - Call #7 ("grep") similar to Call #5 ("grep"): similarity=0.900',
    });

    await round.run(createTurnVars());

    expect(getUserPrompt()).toContain('similarity=0.900');
  });

  it('surfaces pending skills in the HINT note', async () => {
    vi.mocked(retryChat).mockResolvedValueOnce(validHintResponse() as never);
    const { round, env, messages } = makeHarness({
      wiki: makeWiki({ get: vi.fn(async () => [wikiHit('architecture')]) }),
    });
    env.conditions.getPending = vi.fn(() => ['my-skill', 'other-skill']) as never;

    await round.run(createTurnVars());

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
    const { round, messages } = makeHarness({ wiki: makeWiki() });

    await round.run(createTurnVars());

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
    const { round, messages } = makeHarness({ wiki: makeWiki({ get }) });

    const signal = await round.run(createTurnVars());

    // Registered domain search finds nothing, then the all-domains fallback
    // finds nothing → both fields cleared → no line, but the hint still lands.
    expect(get).toHaveBeenCalledTimes(2);
    expect(signal).toBe('continue');
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
    const { round, messages } = makeHarness({ wiki: makeWiki({ get }) });

    const signal = await round.run(createTurnVars());

    expect(signal).toBe('continue');
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
    const { round, messages } = makeHarness({ wiki: makeWiki({ get }) });

    await round.run(createTurnVars());

    expect(get).toHaveBeenCalledTimes(1);
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
    const { round, env, messages } = makeHarness();
    // createMockContext always supplies a wiki module; drop it to model the
    // lite/test wiring that has none.
    delete (env.ctx as { wiki?: unknown }).wiki;

    await round.run(createTurnVars());

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

  it('injects the [HINT] note and never signals a compact outcome', async () => {
    vi.mocked(retryChat).mockResolvedValueOnce(
      validHintResponse({ blocker: 'Agent is looping on a failing test' }) as never,
    );
    const { round, messages } = makeHarness({ wiki: makeWiki() });

    const signal = await round.run(createTurnVars());

    expect(signal).toBe('continue');
    expect(findHint(live(round).messages)).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // "no blockers" note injection (the note is NEVER silently suppressed)
  // ---------------------------------------------------------------------------
  // The hint-round always injects a [HINT] note (there is no suppressing
  // branch), INCLUDING the "no blockers" case. Suppressing the note on
  // "no blockers" was a hazard: it swallowed genuinely valuable guidance
  // (e.g. EXAMPLE D's batch-encouragement coaching, which carries
  // blocker:"no blockers") just because the blocker label was the magic string
  // "no blockers". The anti-auto-progression concern that motivated the old
  // suppression is now handled in the PROMPT: instruction #2 and EXAMPLE C
  // forbid framing next_step as a "Continue ..." authorization. These tests
  // lock in that the note is always injected (no silent no-op), so a
  // regression that re-adds the suppression is caught.
  // ---------------------------------------------------------------------------

  it('injects the [HINT] note when blocker is "no blockers" (note is never silently suppressed)', async () => {
    vi.mocked(retryChat).mockResolvedValueOnce(
      validHintResponse({
        blocker: 'no blockers',
        next_step: 'The remaining work is completing test coverage for the compact module',
        focus_on: 'completing test coverage',
      }) as never,
    );
    const { round, messages } = makeHarness({
      wiki: makeWiki({ get: vi.fn(async () => [wikiHit('architecture')]) }),
    });

    await round.run(createTurnVars());

    // The [HINT] note IS injected — "no blockers" is no longer a silent no-op.
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
    const { round, messages } = makeHarness({
      wiki: makeWiki({ get: vi.fn(async () => [wikiHit('architecture')]) }),
    });

    await round.run(createTurnVars());

    expect(findHint(messages)).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // aborted path (ESC during generation -> 'stop' for centralized wrap-up)
  // ---------------------------------------------------------------------------

  it('returns "stop" when the hint analysis was aborted by ESC', async () => {
    const { round, env } = makeHarness({ wiki: makeWiki() });
    // Simulate ESC: escAware runs its cleanup handler instead of the operation.
    env.ctx.core.escAware = vi.fn(async (_fn, onEsc) => onEsc(new AbortController())) as never;

    const signal = await round.run(createTurnVars());

    expect(signal).toBe('stop');
    expect(retryChat).not.toHaveBeenCalled();
    expect(env.ctx.core.resetConfusionIndex).not.toHaveBeenCalled();
  });

  it('does not call the LLM when the abort controller is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const { round } = makeHarness({
      wiki: makeWiki(),
      escAware: (async (fn: (a: AbortController) => Promise<unknown>) => fn(ac)) as never,
    });

    const signal = await round.run(createTurnVars());

    expect(signal).toBe('stop');
    expect(retryChat).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // retry on malformed / invalid LLM output
  // ---------------------------------------------------------------------------

  it('retries when the LLM returns malformed JSON', async () => {
    vi.mocked(retryChat)
      .mockResolvedValueOnce({ message: { content: 'not json at all' } } as never)
      .mockResolvedValueOnce(validHintResponse() as never);
    const { round, messages } = makeHarness({
      wiki: makeWiki({ get: vi.fn(async () => [wikiHit('architecture')]) }),
    });

    await round.run(createTurnVars());

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
    const { round, messages } = makeHarness({
      wiki: makeWiki({ get: vi.fn(async () => [wikiHit('architecture')]) }),
    });

    await round.run(createTurnVars());

    expect(retryChat).toHaveBeenCalledTimes(2);
  });

  it('retries when the LLM returns an empty string (falls back to "{}")', async () => {
    vi.mocked(retryChat)
      .mockResolvedValueOnce({ message: { content: '' } } as never)
      .mockResolvedValueOnce(validHintResponse() as never);
    const { round, messages } = makeHarness({
      wiki: makeWiki({ get: vi.fn(async () => [wikiHit('architecture')]) }),
    });

    await round.run(createTurnVars());

    expect(retryChat).toHaveBeenCalledTimes(2);
  });

  it('stops after the bounded retry budget and PRESERVES the confusion signal', async () => {
    vi.mocked(retryChat).mockImplementation(async () => ({
      message: { content: 'not json at all' },
    }) as never);
    const { round, env, messages } = makeHarness({ wiki: makeWiki() });
    const turn = createTurnVars();

    const signal = await round.run(turn);

    expect(signal).toBe('continue');
    expect(retryChat).toHaveBeenCalledTimes(3);
    expect(findHint(messages)).toBeUndefined();
    // A failed round is NOT an intervention: the confusion signal stays set so
    // a later COLLECT pass retries once the LLM emits well-formed JSON.
    expect(env.ctx.core.resetConfusionIndex).not.toHaveBeenCalled();
    expect(turn.lastHintFocus).toBe('');
  });

  // ---------------------------------------------------------------------------
  // gate: confusion index + minimum message count
  // ---------------------------------------------------------------------------

  it('skips the round below the confusion threshold', async () => {
    const { round } = makeHarness({ wiki: makeWiki(), confusionIndex: 9 });

    const signal = await round.run(createTurnVars());

    expect(signal).toBe('continue');
    expect(retryChat).not.toHaveBeenCalled();
  });

  it('skips the round below the minimum message count', async () => {
    const { round } = makeHarness({
      wiki: makeWiki(),
      confusionIndex: 30,
      messages: [{ role: 'user', content: 'hi' }],
    });

    const signal = await round.run(createTurnVars());

    expect(signal).toBe('continue');
    expect(retryChat).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // singleton lifecycle
  // ---------------------------------------------------------------------------

  it('returns "continue" when the singleton has no bound env (child process)', async () => {
    const round = new HintRound();
    const signal = await round.run(createTurnVars());
    expect(signal).toBe('continue');
    expect(retryChat).not.toHaveBeenCalled();
  });

  it('unbinds the env on reset()', async () => {
    const { round } = makeHarness({
      wiki: makeWiki({ get: vi.fn(async () => [wikiHit('architecture')]) }),
    });
    round.reset();

    expect(await round.run(createTurnVars())).toBe('continue');
    expect(retryChat).not.toHaveBeenCalled();
  });

  it('exposes the process-wide singleton', () => {
    expect(hintRound).toBeInstanceOf(HintRound);
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
    const { round } = makeHarness({ wiki: wikiWithNoDescriptions });

    await round.run(createTurnVars());

    const userPrompt = getUserPrompt();
    // Empty description → just the domain name, no colon suffix.
    expect(userPrompt).toContain('- project');
    expect(userPrompt).not.toContain('- project:');
  });

  it('handles empty domains list', async () => {
    const wikiEmpty = makeWiki({ listDomains: vi.fn(async () => []) });
    vi.mocked(retryChat).mockResolvedValueOnce(validHintResponse() as never);
    const { round } = makeHarness({ wiki: wikiEmpty });

    await round.run(createTurnVars());

    const userPrompt = getUserPrompt();
    expect(userPrompt).toContain('No domains available');
  });
});

describe('HintRound lifecycle hygiene', () => {
  it('keeps the singleton bound across runs (no per-round reconstruction)', async () => {
    vi.mocked(retryChat).mockResolvedValueOnce(validHintResponse() as never);
    const { env } = makeHarness({
      wiki: makeWiki({ get: vi.fn(async () => [wikiHit('architecture')]) }),
    });
    hintRound.init(env);

    await hintRound.run(createTurnVars());
    // init() with the SAME env must not tear the binding down.
    hintRound.init(env);

    // Count against a snapshot: earlier tests in this file share the mock.
    const callsBefore = vi.mocked(retryChat).mock.calls.length;

    const signal = await hintRound.run(createTurnVars());

    // A clean 'continue' proves the round actually completed (a failed or
    // unbound round would return early WITHOUT reaching the LLM).
    expect(signal).toBe('continue');

    // No reset happened: the round consumed an LLM attempt (>=1 more call than
    // before this run). The per-test retry budget is covered by the tests above;
    // this one only proves the second init(env) did NOT tear the binding down.
    expect(vi.mocked(retryChat).mock.calls.length).toBeGreaterThan(callsBefore);
  });
});

describe('detectRepeatedActions (moved into hint-round.ts)', () => {
  it('reports a repeated tool with a shared error prefix', () => {
    const events = Array.from({ length: 4 }, () => ({
      tool: 'edit_file',
      args: { path: 'a.ts' },
      result: 'Error: old_text not found in file',
      timestamp: Date.now(),
    }));
    expect(detectRepeatedActions(events)).toContain('Repeated actions: edit_file ×4');
  });

  it('returns null when there is no repetition', () => {
    expect(detectRepeatedActions([])).toBeNull();
  });
});