/**
 * crossroad.ts - Crossroad feature: detect turning words in LLM output,
 * generate alternative continuations, and select the best one.
 *
 * Flow:
 * 1. Detect turning word in LLM output (e.g., "However", "Wait", "但")
 * 2. Truncate output at the turning word (keep prefix A)
 * 3. Generate multiple continuations via forkChat in different directions
 * 4. Select the best continuation via LLM
 * 5. Reconstruct triologue with A + C_best + [CONTINUE] continue with your work
 */

import type { Message, Tool, ToolCall } from '../types.js';
import type { RetryConfig } from '../engine/chat-helpers.js';
import { forkChat } from '../engine/chat-provider.js';
import { startSpinner, stopSpinner, sleep } from '../engine/chat-helpers.js';
import { agentIO } from './agent-io.js';

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
  prompt: string;
}

const GENERATION_DIRECTIONS: GenerationDirection[] = [
  {
    name: 'go forward',
    prompt: `You are generating a continuation for a response that was cut off. Continue in a proactive, action-oriented direction. Focus on what to do next, taking decisive steps. Output ONLY the continuation text — no preamble, no sign-off, no tool calls. Start directly from where the prefix left off, maintaining the same tone and voice.`,
  },
  {
    name: 'go backward',
    prompt: `You are generating a continuation for a response that was cut off. Reconsider the basic assumptions and be cautious. Question whether the current direction is correct, and suggest re-examining foundations before proceeding. Output ONLY the continuation text — no preamble, no sign-off, no tool calls. Start directly from where the prefix left off, maintaining the same tone and voice.`,
  },
  {
    name: 'synthesize at a high level',
    prompt: `You are generating a continuation for a response that was cut off. Step back and provide a higher-level abstraction. Synthesize the situation, identify the core question or principle at play, and reframe the problem in broader terms. Output ONLY the continuation text — no preamble, no sign-off, no tool calls. Start directly from where the prefix left off, maintaining the same tone and voice.`,
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
    if (idx < MIN_PREFIX_LENGTH) return false;
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
 * Generate continuations from multiple directions using forkChat.
 * Runs all directions in parallel via Promise.allSettled.
 * Passes full tools + toolChoice: 'none' to preserve prompt cache
 * while constraining text-only output.
 * Returns array of continuation strings (or empty array if all failed).
 */
export async function generateContinuations(
  messages: Message[],
  tools: Tool[],
  prefix: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const results = await Promise.allSettled(
    GENERATION_DIRECTIONS.map((direction) =>
      forkChat(messages, tools, direction.prompt, signal, 'none', CROSSROAD_RETRY_CONFIG).then(
        (text) => ({ directionName: direction.name, text: text.trim() }),
      ),
    ),
  );

  const continuations: string[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.text) {
      agentIO.verbose(
        'crossroad',
        `Direction "${result.value.directionName}" produced: ${result.value.text.slice(0, 100)}...`,
      );
      continuations.push(result.value.text);
    } else if (result.status === 'rejected') {
      const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
      agentIO.verbose('crossroad', `Direction failed: ${msg}`);
    }
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
  _originalToolCalls: ToolCall[],
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

  // Show spinner during processing
  startSpinner('LLM is at its crossroad...');
  try {
    // Step 3: Generate continuations (with crossroad-level retry)
    let continuations = await generateContinuations(messages, tools, prefix, signal);
    if (continuations.length === 0) {
      agentIO.verbose('crossroad', 'All continuations failed, retrying once...');
      await sleep(500);
      continuations = await generateContinuations(messages, tools, prefix, signal);
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

    agentIO.verbose('crossroad', `Selected continuation: ${best.slice(0, 150)}...`);
    return { truncated: prefix, continuation: best };
  } finally {
    stopSpinner();
  }
}