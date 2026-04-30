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
import type { LineEditor } from '../utils/line-editor.js';
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
 * Run the wrap-up LLM call.
 * Builds a temporary messages array (triologue + wrap-up prompt) without
 * modifying the triologue. The triologue is only updated in injectWrapUp()
 * when the wrap-up succeeded and the grace period has passed.
 */
async function runWrapUpLLM(triologue: Triologue): Promise<string> {
  const messages = [
    ...triologue.getMessages(),
    { role: 'user' as const, content: WRAP_UP_USER_MESSAGE },
  ];

  try {
    const response = await retryChat(
      {
        model: MODEL,
        messages,
        tools: [], // No tools for wrap-up
        think: true,
      },
      { noSpinner: true },
    );

    return response.message?.content || '';
  } catch {
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

  promise.then((content) => {
    if (wrapUpState.promise !== promise) return;
    wrapUpState.content = content;
    wrapUpState.completedAt = Date.now();
  }).catch(() => {
    if (wrapUpState.promise !== promise) return;
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
  return wrapUpState.content !== null && wrapUpState.content !== '' && !wrapUpState.shown;
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

  // No wrap-up content, empty (failed), or already shown - discard
  if (!content || shown) {
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
 * Inject wrap-up into triologue (user message + agent response).
 * Only called when wrap-up succeeded with non-empty content
 * and the grace period has passed.
 */
export function injectWrapUp(): void {
  if (wrapUpState.triologue && wrapUpState.content) {
    wrapUpState.triologue.user(WRAP_UP_USER_MESSAGE);
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
 * Try to display a pending wrap-up above the given editor.
 * If wrap-up content is ready, clears the editor from screen,
 * displays the letter-box, and re-renders the editor below it.
 * Returns true if the wrap-up was shown, false otherwise.
 */
export function tryDisplayWrapUp(editor: LineEditor | null): boolean {
  if (!hasPendingWrapUp()) return false;
  const { content } = wrapUpState;
  if (!content || !content.trim() || !editor) return false;
  markWrapUpShown();
  editor.prepareForExternalContentAbove();
  displayWrapUp(content);
  editor.rerender();
  return true;
}

