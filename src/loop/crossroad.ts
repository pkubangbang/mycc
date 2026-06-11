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

import type { Message, ToolCall } from '../types.js';
import { forkChat } from '../engine/chat-provider.js';
import { startSpinner, stopSpinner } from '../engine/chat-helpers.js';
import { agentIO } from './agent-io.js';

// ============================================================================
// Turning Words
// ============================================================================

/** Regex patterns for turning words — indicators that LLM is changing its mind */
const TURNING_WORDS: RegExp[] = [
  // English
  /\bHowever\b/i,
  /\bActually\b/i,
  /\bWait\b/i,
  /\bBut\b/i,
  /\bNevertheless\b/i,
  /\bNonetheless\b/i,
  /\bOn the other hand\b/i,
  /\bThat said\b/i,
  /\bThat being said\b/i,
  /\bHaving said that\b/i,
  // Chinese
  /等等/,
  /但/,
  /不过/,
  /然而/,
  /其实/,
  /等一下/,
  /话说回来/,
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

// ============================================================================
// Detection
// ============================================================================

interface TurningWordMatch {
  word: string;
  index: number;
}

/**
 * Detect the first turning word in content.
 * Returns the matched word and its position, or null if no turning word found.
 */
export function detectTurningWord(content: string): TurningWordMatch | null {
  let earliest: TurningWordMatch | null = null;

  for (const regex of TURNING_WORDS) {
    const match = content.match(regex);
    if (match && match.index !== undefined) {
      if (!earliest || match.index < earliest.index) {
        earliest = { word: match[0], index: match.index };
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
 * Each forkChat call passes empty tools to constrain text-only output.
 * Returns array of continuation strings (or empty array if all failed).
 */
export async function generateContinuations(
  messages: Message[],
  prefix: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const results: string[] = [];

  for (const direction of GENERATION_DIRECTIONS) {
    try {
      // Use forkChat with empty tools array to force text-only output
      const text = await forkChat(messages, [], direction.prompt, signal);
      if (text && text.trim()) {
        agentIO.verbose('crossroad', `Direction "${direction.name}" produced: ${text.slice(0, 100)}...`);
        results.push(text.trim());
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      agentIO.verbose('crossroad', `Direction "${direction.name}" failed: ${msg}`);
      // Silently catch — we proceed with whatever we got
    }
  }

  return results;
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
    const response = await forkChat(messages, [], selectionPrompt, signal);
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
    // Step 3: Generate continuations
    const continuations = await generateContinuations(messages, prefix, signal);
    if (continuations.length === 0) {
      agentIO.verbose('crossroad', 'No continuations generated, aborting crossroad');
      return null;
    }

    // Step 4: Select the best one
    const best = await selectBestContinuation(messages, prefix, continuations, signal);
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