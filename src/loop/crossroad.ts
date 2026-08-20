/**
 * crossroad.ts - Crossroad feature: detect turning words in LLM output,
 * generate alternative continuations, and select the best one.
 *
 * Flow:
 * 1. Detect turning word in LLM output (e.g., "However", "Wait", "但")
 * 2. Truncate output at the turning word (keep prefix A)
 * 3. Generate multiple continuations via forkChat in different directions
 * 4. Select the best continuation via LLM
 * 5. Reconstruct triologue with A + C_best + [REMINDER] continue with your work
 */

import type { Message, Tool } from '../types.js';
import type { RetryConfig } from '../engine/chat-helpers.js';
import { forkChat } from '../engine/chat-provider.js';
import { startSpinner, stopSpinner, sleep } from '../engine/chat-helpers.js';
import { agentIO } from './agent-io.js';
import { stripInternalMarkup } from '../utils/letter-box.js';

// ============================================================================
// Turning Words
// ============================================================================

/**
 * Turning-word detection is tiered to reduce false positives.
 *
 * A genuine "turning word" means the LLM is changing its own mind mid-response —
 * it committed to a direction, then pivots to contradict or reverse course.
 * This is distinct from ordinary conjunctions used for balanced analysis.
 *
 * Key heuristics:
 * 1. Minimum prefix length (60 chars) — the LLM must have said something substantive
 *    before the turn, otherwise it hasn't "committed" to a direction yet.
 * 2. Minimum suffix length (15 chars) — there must be meaningful content after the
 *    turn; a turning word at the very end is just trailing rhetoric.
 * 3. Sentence-boundary requirement for weak signals — common conjunctions like "But"
 *    and "However" only count as turns when they start a new sentence/paragraph,
 *    not when used mid-sentence for balanced contrast.
 * 4. Refined patterns for ambiguous words — "Wait" must be an interjection (not
 *    "wait for/until/to"), "等等" must mean "wait!" (not "etc.").
 */

/**
 * Minimum chars before a turning word — ensures LLM has committed to a direction.
 * Set to 30 to work for both English (~one substantial sentence) and Chinese
 * (where each character carries more meaning; 30 chars ≈ two full sentences).
 *
 * Exception: position 0 (turning word at the very start of the response) is
 * always allowed, because the LLM's "commitment" was in the conversation
 * history (previous assistant messages), not in the current response text.
 */
const MIN_PREFIX_LENGTH = 30;

/** Minimum chars after a turning word — ensures there is content after the pivot */
const MIN_SUFFIX_LENGTH = 15;

/**
 * Tier 1 — Strong turning signals.
 * These phrases almost always indicate the speaker is reversing course.
 * Subject only to position checks (prefix/suffix length).
 */
const STRONG_TURNING_WORDS: RegExp[] = [
  /\bHaving said that\b/i,
  /\bThat being said\b/i,
  /\bOn the other hand\b/i,
  /话说回来/,
  /等一下/,
];

/**
 * Tier 2 — Sentence-boundary conjunctions.
 * These are common words that ONLY indicate a turn when they start a new
 * sentence or paragraph. Mid-sentence usage is ordinary balanced analysis.
 */
const SENTENCE_BOUNDARY_TURNING_WORDS: RegExp[] = [
  /\bHowever\b/i,
  /\bNevertheless\b/i,
  /\bNonetheless\b/i,
  /\bThat said\b/i,
  /\bActually\b/i,
  /\bBut\b/i,
  // Chinese — match only after sentence-ending punctuation or newline
  /(?<=^|[。！？\n])\s*然而/,
  /(?<=^|[。！？\n])\s*但/,
  /(?<=^|[。！？\n])\s*不过/,
  /(?<=^|[。！？\n])\s*其实/,
];

/**
 * Tier 3 — Special patterns that need extra context to disambiguate.
 *
 * "Wait" must be an interjection (followed by punctuation), not a verb
 * meaning "await" (followed by "for", "until", "to", etc.).
 *
 * "等等" must mean "wait!" (followed by punctuation), not "etc."
 * (list terminator followed by more sentence content).
 */
const SPECIAL_TURNING_PATTERNS: RegExp[] = [
  // "Wait" as interjection: followed by comma, exclamation, dash, ellipsis, or end-of-text
  /\bWait\b(?=\s*[,!.—]|\s*$)/i,
  // "等等" as interjection: followed by Chinese/English punctuation or end-of-text
  /等等(?=\s*[,，!！。.—]|\s*$)/,
];

// ============================================================================
// Direction Prompts for Continuation Generation
// ============================================================================

interface GenerationDirection {
  name: string;
  /** Build the direction prompt, injecting the anchor sentence to repeat. */
  buildPrompt: (wordsBeforeTurn: string) => string;
}

/**
 * Core instruction appended to every direction. The anchor sentence
 * (wordsBeforeTurn) is the last sentence of the prefix — the LLM MUST
 * start by repeating it verbatim, so the continuation dovetails with
 * the prefix and no earlier prefix content is restated. The post-
 * processing in stripAndValidate then removes the anchor, leaving only
 * the genuinely new content.
 */
const ANCHOR_INSTRUCTION = (wordsBeforeTurn: string): string =>
  `\n\nYou MUST start your continuation by repeating this exact sentence from the prefix verbatim:\n"""\n${wordsBeforeTurn}\n"""\nAfter that sentence, provide your new direction. Do not restate any other content from the prefix — the user has already seen it. Keep your continuation brief — at most 2-3 concise sentences after the anchor. Do not start a new complex reasoning chain; just provide a short, clear direction pivot.`;

const GENERATION_DIRECTIONS: GenerationDirection[] = [
  {
    name: 'go forward',
    buildPrompt: (w) => `You are generating a continuation for a response that was cut off. Continue in a proactive, action-oriented direction. Focus on what to do next, taking decisive steps. Output ONLY the continuation text — no preamble, no sign-off, no tool calls. Start directly from where the prefix left off, maintaining the same tone and voice.${ANCHOR_INSTRUCTION(w)}`,
  },
  {
    name: 'go backward',
    buildPrompt: (w) => `You are generating a continuation for a response that was cut off. Reconsider the basic assumptions and be cautious. Question whether the current direction is correct, and suggest re-examining foundations before proceeding. Output ONLY the continuation text — no preamble, no sign-off, no tool calls. Start directly from where the prefix left off, maintaining the same tone and voice.${ANCHOR_INSTRUCTION(w)}`,
  },
  {
    name: 'synthesize at a high level',
    buildPrompt: (w) => `You are generating a continuation for a response that was cut off. Step back and provide a higher-level abstraction. Synthesize the situation, identify the core question or principle at play, and reframe the problem in broader terms. Output ONLY the continuation text — no preamble, no sign-off, no tool calls. Start directly from where the prefix left off, maintaining the same tone and voice.${ANCHOR_INSTRUCTION(w)}`,
  },
];

/**
 * Tighter retry config for crossroad continuation generation.
 * Crossroad continuations are short text-only responses, so the generous
 * defaults (20s first-token / 120s response) would cause unacceptable
 * delays during network failures. 10s/30s with 1 retry is sufficient.
 */
const CROSSROAD_RETRY_CONFIG: Partial<RetryConfig> = {
  firstTokenTimeoutMs: 10_000,
  responseTimeoutMs: 30_000,
  maxRetries: 1,
  baseDelayMs: 500,
  maxDelayMs: 3_000,
};

// ============================================================================
// Detection
// ============================================================================

interface TurningWordMatch {
  word: string;
  index: number;
}

/**
 * Check whether a position in content is at a sentence or paragraph boundary.
 * A boundary is: start of text, after .!? or 。！？, or after a newline.
 * We look at the 3 characters immediately before the position.
 */
function isAtSentenceBoundary(content: string, index: number): boolean {
  if (index === 0) return true;
  const before = content.slice(Math.max(0, index - 3), index);
  return /[.!?。！？]\s*$/.test(before) || /\n\s*$/.test(before);
}

/**
 * Detect the first turning word in content using tiered matching with
 * accuracy guards to reduce false positives.
 *
 * Tier 1 (strong signals): always flag, subject to position checks.
 * Tier 2 (sentence-boundary): only flag when at a sentence/paragraph start.
 * Tier 3 (special patterns): refined regex already encodes disambiguation.
 *
 * All matches must pass:
 * - MIN_PREFIX_LENGTH: enough content before the turn (LLM committed to a direction)
 * - MIN_SUFFIX_LENGTH: enough content after the turn (not just trailing rhetoric)
 *
 * Returns the matched word and its position, or null if no turning word found.
 */
export function detectTurningWord(content: string): TurningWordMatch | null {
  let earliest: TurningWordMatch | null = null;

  // Helper: test a candidate match against all guards
  const acceptCandidate = (match: RegExpMatchArray, requireBoundary: boolean): boolean => {
    if (match.index === undefined) return false;
    const idx = match.index;
    // Position guards
    // Allow position-0 turning words: the LLM's "commitment" was in the
    // conversation history (previous assistant messages), not in the current
    // response. A turning word at the very start of a response is a genuine
    // reversal of course from the previous turn's direction.
    if (idx > 0 && idx < MIN_PREFIX_LENGTH) return false;
    if (idx + match[0].length + MIN_SUFFIX_LENGTH > content.length) return false;
    // Sentence-boundary guard (only for tier 2)
    if (requireBoundary && !isAtSentenceBoundary(content, idx)) return false;
    return true;
  };

  /**
   * Build a global regex from a source pattern for matchAll().
   * matchAll() requires the `g` flag; we add it if not already present.
   */
  const toGlobal = (regex: RegExp): RegExp =>
    new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);

  // Scan tier 1 — strong signals (no boundary requirement)
  for (const regex of STRONG_TURNING_WORDS) {
    for (const match of content.matchAll(toGlobal(regex))) {
      if (acceptCandidate(match, false)) {
        if (!earliest || match.index! < earliest.index) {
          earliest = { word: match[0], index: match.index! };
        }
        break; // Only need the first valid match per pattern
      }
    }
  }

  // Scan tier 2 — sentence-boundary conjunctions
  for (const regex of SENTENCE_BOUNDARY_TURNING_WORDS) {
    for (const match of content.matchAll(toGlobal(regex))) {
      if (acceptCandidate(match, true)) {
        if (!earliest || match.index! < earliest.index) {
          earliest = { word: match[0], index: match.index! };
        }
        break;
      }
    }
  }

  // Scan tier 3 — special patterns (boundary already encoded in regex)
  for (const regex of SPECIAL_TURNING_PATTERNS) {
    for (const match of content.matchAll(toGlobal(regex))) {
      if (acceptCandidate(match, false)) {
        if (!earliest || match.index! < earliest.index) {
          earliest = { word: match[0], index: match.index! };
        }
        break;
      }
    }
  }

  return earliest;
}

// ============================================================================
// Continuation Generation
// ============================================================================

/**
 * Validate that a continuation starts with the anchor sentence (wordsBeforeTurn)
 * and strip the anchor, leaving only the new content.
 *
 * The generation prompt forces the LLM to begin by repeating wordsBeforeTurn
 * verbatim. This function checks that requirement:
 *  - If the continuation starts with wordsBeforeTurn → strip it, return the rest.
 *  - If the continuation does NOT start with wordsBeforeTurn → return null
 *    (validation failed — caller should retry, then give up).
 *  - If wordsBeforeTurn is empty → return the continuation unchanged (no anchor
 *    to enforce; e.g. prefix was empty or had no sentence boundary).
 *  - If stripping leaves nothing → return null (continuation was ONLY the anchor).
 *
 * @param wordsBeforeTurn - The anchor sentence (last sentence of the prefix)
 * @param continuation - The raw continuation text (already stripInternalMarkup'd)
 * @returns The continuation with the anchor removed, or null if validation failed
 */
export function stripAndValidate(wordsBeforeTurn: string, continuation: string): string | null {
  if (!wordsBeforeTurn) return continuation;
  if (continuation.startsWith(wordsBeforeTurn)) {
    const stripped = continuation.slice(wordsBeforeTurn.length).trim();
    return stripped.length > 0 ? stripped : null;
  }
  return null;
}

/**
 * Extract the last sentence of the prefix — the anchor that continuations
 * must repeat verbatim before pivoting. Splits on English/Chinese sentence
 * boundaries and newlines.
 *
 * Split strategy: English sentences end with .!? followed by whitespace,
 * so the lookbehind requires the punctuation + \s+. Chinese sentences end
 * with 。！？ with NO following whitespace, so those are split directly
 * (keeping the punctuation with the preceding sentence). Newlines also
 * act as boundaries.
 */
export function extractWordsBeforeTurn(prefix: string): string {
  const sentences = prefix
    .split(/(?<=[.!?])\s+|(?<=[。！？])|\n+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
  return sentences.length > 0 ? sentences[sentences.length - 1] : '';
}

/**
 * Generate continuations from multiple directions using forkChat.
 * Runs all directions in parallel via Promise.allSettled.
 * Passes full tools + toolChoice: 'none' to preserve prompt cache
 * while constraining text-only output.
 *
 * Each continuation MUST start with the anchor sentence (wordsBeforeTurn).
 * stripAndValidate checks this and strips the anchor. If validation fails,
 * that direction is retried once with the same prompt. If the retry also
 * fails validation, the direction is skipped (not included in results).
 *
 * Returns array of continuation strings (anchor stripped), or empty array
 * if all directions failed (including retries).
 */
export async function generateContinuations(
  messages: Message[],
  tools: Tool[],
  prefix: string,
  signal?: AbortSignal,
  wordsBeforeTurn: string = '',
): Promise<string[]> {
  // Inject the prefix into each direction prompt so the LLM sees what was
  // already said and continues from it rather than regenerating it from
  // scratch. Without this, forkChat only sees conversation history + the
  // direction instruction, so it restates the prefix before pivoting —
  // producing duplicated content in the final assembled output.
  const prefixBlock = `A response was cut off at a turning word. The prefix (before the turning word, already written and shown to the user) is:\n\n"""\n${prefix}\n"""\n\n`;

  /**
   * Run one direction: forkChat → stripInternalMarkup → stripAndValidate.
   * On validation failure, retry once. Returns the validated continuation
   * (anchor stripped) or null if both attempts fail.
   */
  const runDirection = async (direction: GenerationDirection): Promise<{ name: string; text: string } | null> => {
    const fullPrompt = prefixBlock + direction.buildPrompt(wordsBeforeTurn);

    // First attempt
    let raw = await forkChat(messages, tools, fullPrompt, signal, 'none', CROSSROAD_RETRY_CONFIG);
    let cleanText = stripInternalMarkup((raw || '').trim());
    let validated = stripAndValidate(wordsBeforeTurn, cleanText);
    if (validated !== null) {
      return { name: direction.name, text: validated };
    }

    // Retry once — validation failed (continuation didn't start with anchor)
    agentIO.verbose('crossroad',
      `Direction "${direction.name}" failed anchor validation, retrying...`);
    await sleep(300);
    raw = await forkChat(messages, tools, fullPrompt, signal, 'none', CROSSROAD_RETRY_CONFIG);
    cleanText = stripInternalMarkup((raw || '').trim());
    validated = stripAndValidate(wordsBeforeTurn, cleanText);
    if (validated !== null) {
      return { name: direction.name, text: validated };
    }

    // Both attempts failed — skip this direction
    agentIO.verbose('crossroad',
      `Direction "${direction.name}" failed anchor validation after retry, skipping.`);
    return null;
  };

  const results = await Promise.allSettled(
    GENERATION_DIRECTIONS.map((direction) => runDirection(direction)),
  );

  const continuations: string[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      agentIO.verbose('crossroad',
        `Direction "${result.value.name}" produced: ${result.value.text.slice(0, 100)}...`);
      continuations.push(result.value.text);
    } else if (result.status === 'rejected') {
      const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
      agentIO.verbose('crossroad', `Direction failed: ${msg}`);
    }
    // else: fulfilled with null → already logged in runDirection
  }

  return continuations;
}

// ============================================================================
// Continuation Selection
// ============================================================================

/**
 * Build the selection prompt that presents all continuations to the LLM.
 */
function buildSelectionPrompt(prefix: string, continuations: string[]): string {
  const parts: string[] = [
    `A response was cut off at a turning word. The prefix (before the turning word) is:\n\n"""\n${prefix}\n"""\n\n`,
    `Below are ${continuations.length} possible continuations for this response. Read each one carefully, then select the BEST one.\n\n`,
  ];

  for (let i = 0; i < continuations.length; i++) {
    parts.push(`---\nOption ${i + 1}:\n${continuations[i]}\n`);
  }

  parts.push(`\n---\n`);
  parts.push(`Which option is the best continuation? Consider:
1. Which one flows most naturally from the prefix?
2. Which one is most useful and actionable?
3. Which one shows the best judgment?
4. Which one is most concise and direct?

Reply with EXACTLY ONE line containing only the option number (e.g., "1", "2", or "3").
Then on the next line, optionally provide the full text of that option as the continuation.
No other text, no preamble, no sign-off.`);

  return parts.join('');
}

/**
 * Select the best continuation from generated options using the LLM.
 * Returns the selected continuation text, or the first one if selection fails.
 */
export async function selectBestContinuation(
  messages: Message[],
  tools: Tool[],
  prefix: string,
  continuations: string[],
  signal?: AbortSignal,
): Promise<string> {
  if (continuations.length === 0) {
    return '';
  }
  if (continuations.length === 1) {
    return continuations[0];
  }

  const selectionPrompt = buildSelectionPrompt(prefix, continuations);

  try {
    const response = await forkChat(messages, tools, selectionPrompt, signal, 'none', CROSSROAD_RETRY_CONFIG);
    const text = (response || '').trim();
    agentIO.verbose('crossroad', `Selection response: ${text.slice(0, 200)}...`);

    // Try to parse the selected option number from the response
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const firstLine = lines[0] || '';

    // Match "N" or "Option N" at the start
    const optionMatch = firstLine.match(/^(?:option\s*)?(\d+)/i);
    if (optionMatch) {
      const optionIndex = parseInt(optionMatch[1], 10) - 1;
      if (optionIndex >= 0 && optionIndex < continuations.length) {
        // If the second line contains the actual continuation text, use it
        if (lines.length > 1) {
          const continuationText = lines.slice(1).join('\n');
          if (continuationText.length > 10) {
            return continuationText;
          }
        }
        return continuations[optionIndex];
      }
    }

    // If selection parsing failed, just return the best matching continuation
    // by checking which one appears in the response
    for (const c of continuations) {
      if (text.includes(c.slice(0, 50))) {
        return c;
      }
    }

    // Fallback: return the first continuation
    agentIO.verbose('crossroad', 'Could not parse selection, using first continuation');
    return continuations[0];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    agentIO.verbose('crossroad', `Selection failed: ${msg}`);
    return continuations[0];
  }
}

// ============================================================================
// Orchestrator
// ============================================================================

export interface CrossroadResult {
  /** Text before the turning word (truncated original) */
  truncated: string;
  /** The best continuation text */
  continuation: string;
  /** All candidate continuations (for the crossroad record file) */
  candidates: string[];
}

/**
 * Handle the crossroad feature:
 * 1. Detect turning word in original content
 * 2. Truncate at turning word
 * 3. Generate multiple continuations
 * 4. Select the best one
 *
 * Returns null if no turning word is found or if all generation fails.
 * Shows spinner during processing.
 */
export async function handleCrossroad(
  messages: Message[],
  originalContent: string,
  tools: Tool[],
  signal?: AbortSignal,
): Promise<CrossroadResult | null> {
  // Step 1: Detect turning word
  const match = detectTurningWord(originalContent);
  if (!match) {
    return null;
  }

  agentIO.verbose('crossroad', `Detected turning word "${match.word}" at index ${match.index}`);

  // Step 2: Truncate at turning word
  const prefix = originalContent.slice(0, match.index).trim();
  // Extract the last sentence of the prefix — the anchor that continuations
  // must repeat verbatim. This enforces a clean dovetail: the continuation
  // starts by echoing the prefix's final sentence, then pivots. After
  // stripAndValidate removes the anchor, only genuinely new content remains.
  const wordsBeforeTurn = extractWordsBeforeTurn(prefix);

  // Show spinner during processing
  startSpinner('LLM is at its crossroad...');
  let result: CrossroadResult | null = null;
  let continuations: string[] = [];
  let selectedIndex = -1;
  try {
    // Step 3: Generate continuations (with crossroad-level retry)
    continuations = await generateContinuations(messages, tools, prefix, signal, wordsBeforeTurn);
    if (continuations.length === 0) {
      agentIO.verbose('crossroad', 'All continuations failed, retrying once...');
      await sleep(500);
      continuations = await generateContinuations(messages, tools, prefix, signal, wordsBeforeTurn);
    }
    if (continuations.length === 0) {
      agentIO.verbose('crossroad', 'No continuations generated after retry, aborting crossroad');
      return null;
    }

    // Step 4: Select the best one
    const best = await selectBestContinuation(messages, tools, prefix, continuations, signal);
    if (!best) {
      agentIO.verbose('crossroad', 'Best continuation is empty, aborting crossroad');
      return null;
    }

    selectedIndex = continuations.indexOf(best);
    agentIO.verbose('crossroad', `Selected continuation #${selectedIndex + 1}: ${best.slice(0, 150)}...`);
    result = { truncated: prefix, continuation: best, candidates: continuations };
    return result;
  } finally {
    stopSpinner();
    // Log all alternatives and which was chosen (after spinner stops for clean output)
    if (result && continuations.length > 1) {
      // Emit a markdown block so it renders cleanly in BOTH the terminal
      // (plain text is readable) and the Web UI (markdown rendered for
      // labeled `log` messages — see MessageItem.vue). Avoid chalk/box-drawing
      // characters: they leak ANSI codes into the Web UI and the box breaks
      // on narrow viewports. A markdown list with ✅/⬜ emoji markers keeps
      // the selected option visually distinct and bolds its direction name.
      const lines: string[] = [];
      lines.push('');
      lines.push(`### 🚦 Crossroad (selected ${selectedIndex + 1} of ${continuations.length})`);
      for (let i = 0; i < continuations.length; i++) {
        const isSelected = i === selectedIndex;
        const directionName = GENERATION_DIRECTIONS[i]?.name ?? `option ${i + 1}`;
        const marker = isSelected ? '✅' : '⬜';
        const preview = continuations[i].length > 100
          ? `${continuations[i].slice(0, 100)}…`
          : continuations[i];
        const namePart = isSelected ? `**${directionName}**` : directionName;
        lines.push(`- ${marker} **${namePart}**: ${preview}${isSelected ? '  _(selected)_' : ''}`);
      }
      agentIO.brief('info', 'crossroad', lines.join('\n'));
    }
  }
}