/**
 * esc-wrap-up.ts - Quick-return ESC wrap-up state management
 *
 * When ESC is pressed during an LLM call, the prompt should show immediately
 * while the LLM wrap-up continues in background. The wrap-up appears as a
 * letter-box above the prompt when complete.
 *
 * Timing logic:
 * - If user submits query before wrap-up shows → discard wrap-up
 * - If user submits query within 3s of wrap-up showing → discard wrap-up
 * - If user submits query after 3s of wrap-up showing → append wrap-up to triologue
 */

import { displayLetterBox } from '../utils/letter-box.js';
import type { Triologue } from './triologue.js';
import { retryChat, MODEL } from '../ollama.js';

/**
 * WrapUpState - Tracks the state of background wrap-up after ESC
 */
export interface WrapUpState {
  /** Promise that resolves when wrap-up LLM call completes */
  promise: Promise<string> | null;
  /** Content from the wrap-up response (set when complete) */
  content: string | null;
  /** Timestamp when wrap-up completed (ms since epoch) */
  completedAt: number | null;
  /** Whether the wrap-up content has been shown to user */
  shown: boolean;
  /** The triologue to inject messages into when wrap-up completes */
  triologue: Triologue | null;
}

/**
 * Grace period for wrap-up append (ms)
 * If user submits within this time after wrap-up shows, wrap-up is discarded
 */
export const WRAP_UP_GRACE_PERIOD_MS = 3000;

/**
 * User message to add to triologue when wrap-up is injected
 */
const WRAP_UP_USER_MESSAGE = 'LLM call interrupted. Please wrap up quickly and ask user for next steps.';

// Singleton wrap-up state
let wrapUpState: WrapUpState = {
  promise: null,
  content: null,
  completedAt: null,
  shown: false,
  triologue: null,
};

/**
 * Run the wrap-up LLM call
 * Adds user prompt to triologue and calls LLM for wrap-up response
 */
async function runWrapUpLLM(triologue: Triologue): Promise<string> {
  // Add user prompt for wrap-up
  triologue.user(WRAP_UP_USER_MESSAGE);

  try {
    const response = await retryChat(
      {
        model: MODEL,
        messages: triologue.getMessages(),
        tools: [], // No tools for wrap-up
        think: true,
      },
      { noSpinner: true },
    );

    return response.message?.content || '';
  } catch {
    // Wrap-up failed - return empty content
    return '';
  }
}

/**
 * Start tracking a background wrap-up operation
 * Runs the LLM wrap-up in background and stores triologue for later injection
 */
export function startWrapUp(triologue: Triologue): void {
  const promise = runWrapUpLLM(triologue);
  wrapUpState = {
    promise,
    content: null,
    completedAt: null,
    shown: false,
    triologue,
  };

  // When wrap-up completes, store the content and timestamp
  promise.then((content) => {
    wrapUpState.content = content;
    wrapUpState.completedAt = Date.now();
  }).catch(() => {
    // Wrap-up was cancelled or failed - clear state
    wrapUpState.content = '';
    wrapUpState.completedAt = Date.now();
  });
}

/**
 * Get current wrap-up state
 */
export function getWrapUpState(): WrapUpState {
  return wrapUpState;
}

/**
 * Check if wrap-up has completed and not yet shown
 */
export function hasPendingWrapUp(): boolean {
  return wrapUpState.content !== null && !wrapUpState.shown;
}

/**
 * Mark wrap-up as shown
 */
export function markWrapUpShown(): void {
  wrapUpState.shown = true;
}

/**
 * Clear wrap-up state (discard without showing)
 */
export function clearWrapUp(): void {
  wrapUpState = {
    promise: null,
    content: null,
    completedAt: null,
    shown: false,
    triologue: null,
  };
}

/**
 * Check if user query should be appended (submitted after grace period)
 * Returns: 'append' if wrap-up should be appended, 'discard' if wrap-up should be discarded
 */
export function shouldAppendWrapUp(): 'append' | 'discard' {
  const { completedAt, shown, content } = wrapUpState;

  // No wrap-up content or already shown - discard
  if (content === null || shown) {
    return 'discard';
  }

  // Wrap-up not yet completed - discard (user submitted before wrap-up)
  if (completedAt === null) {
    return 'discard';
  }

  // Check if within grace period (3s after wrap-up shows)
  const now = Date.now();
  const timeSinceCompletion = now - completedAt;

  // If more than 3s since completion, append wrap-up
  if (timeSinceCompletion >= WRAP_UP_GRACE_PERIOD_MS) {
    return 'append';
  }

  // Within grace period - discard wrap-up, let user query go through directly
  return 'discard';
}

/**
 * Inject wrap-up into triologue (user message + agent response)
 * Called when grace period allows injection
 * Note: The user message was already added during runWrapUpLLM, so we only add the agent response
 */
export function injectWrapUp(): void {
  if (wrapUpState.triologue && wrapUpState.content) {
    wrapUpState.triologue.agent(wrapUpState.content);
  }
}

/**
 * Display wrap-up content in letter-box format
 * Shows the wrap-up above the current line-editor prompt
 */
export function displayWrapUp(content: string): void {
  if (content && content.trim()) {
    displayLetterBox(content);
  }
}

/**
 * Poll for completed wrap-up and display it if ready.
 * Encapsulates: pending check → get content → mark shown → display letter-box.
 * Returns the content if wrap-up was just displayed, null otherwise.
 * Caller is responsible for re-rendering the prompt after display.
 */
export function pollAndDisplayWrapUp(): string | null {
  if (!hasPendingWrapUp()) return null;
  const { content } = wrapUpState;
  if (!content || content === '') return null;
  markWrapUpShown();
  displayWrapUp(content);
  return content;
}