/**
 * esc-wrap-up.ts - Quick-return ESC wrap-up state management
 *
 * When ESC is pressed during an LLM call, the prompt should show immediately
 * while the LLM wrap-up continues in background. The wrap-up appears as a
 * letter-box above the prompt when complete.
 *
 * Architecture (redesigned to avoid triologue parity issues):
 *
 * 1. ESC pressed → startWrapUp() calls triologue.beginWrapUp()
 *    - Adds [WRAP_UP] user message inline to triologue (never combined)
 *    - Background LLM call runs to get wrap-up content
 *    - Returns immediately so prompt shows ASAP
 *
 * 2. Wrap-up LLM completes → Promise resolves in background
 *    - Calls triologue.finishWrapUp(content) to add agent response inline
 *    - Stores content + completion timestamp for letter-box display
 *
 * 3. User submits next query → in prompt.ts:
 *    - If wrap-up completed AND past 3s grace period:
 *      → triologue.commitWrapUp() — permanently keep the wrap-up turn
 *    - If wrap-up not completed OR within 3s:
 *      → triologue.rollbackWrapUp() — remove wrap-up messages via truncation
 *
 * Key benefit: No message snapshot. The wrap-up turn is always in the triologue
 * at the correct position. rollbackWrapUp() is a simple array .length truncation,
 * instant and race-free.
 */

import { displayLetterBox } from '../utils/letter-box.js';
import type { Triologue } from './triologue.js';
import type { LineEditor } from '../utils/line-editor.js';
import { retryChat, MODEL } from '../engine/chat-provider.js';
import { getApiProvider } from '../config.js';
import type { Tool } from 'ollama';

/**
 * WrapUpState - Tracks the state of background wrap-up after ESC
 */
interface WrapUpState {
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
const WRAP_UP_GRACE_PERIOD_MS = 3000;

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
 * Uses triologue.getMessages() which INCLUDES the WRAP_UP note added by
 * beginWrapUp() — always fresh, no snapshot needed.
 *
 * For DeepSeek: keeps the full tool list so the model has context, but sets
 * tool_choice='none' to prevent tool calls (avoids raw XML in content).
 * For Ollama: passes empty tools list (unchanged behavior).
 */
async function runWrapUpLLM(triologue: Triologue, tools?: Tool[]): Promise<string> {
  const messages = triologue.getMessages();
  const isDeepseek = getApiProvider() === 'deepseek';

  try {
    const response = isDeepseek
      ? await retryChat(
          {
            model: MODEL,
            messages,
            tools: tools || [],
            think: true,
            toolChoice: 'none',
          } as Parameters<typeof retryChat>[0],
          { noSpinner: true },
        )
      : await retryChat(
          {
            model: MODEL,
            messages,
            tools: [],
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
 * Start tracking a background wrap-up operation.
 * Calls triologue.beginWrapUp() to add WRAP_UP note inline.
 * Runs the LLM wrap-up in background.
 */
export function startWrapUp(triologue: Triologue, tools?: Tool[]): void {
  // Add WRAP_UP user message inline (always separate, never combined)
  triologue.beginWrapUp();

  const promise = runWrapUpLLM(triologue, tools);
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

    if (content) {
      // Try to add agent response.
      // If triologue was already rolled back (user submitted quickly),
      // finishWrapUp is a no-op (wrapUpMark === -1).
      triologue.finishWrapUp(content);
    }
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
 * Check if the wrap-up is ready (completed with content) and past the grace period.
 * If yes, returns 'commit' — caller should call commitWrapUp() on the triologue.
 * If no, returns 'rollback' — caller should call rollbackWrapUp() on the triologue.
 * Note: After calling commitWrapUp() or rollbackWrapUp(), caller should also
 * call clearWrapUp() to reset the wrap-up state.
 */
export function evaluateWrapUp(): 'commit' | 'rollback' {
  const { completedAt, shown, content } = wrapUpState;

  // No wrap-up content, empty (failed), or already shown - rollback
  if (!content || shown) {
    return 'rollback';
  }

  // Wrap-up not yet completed - rollback (user submitted before wrap-up)
  if (completedAt === null) {
    return 'rollback';
  }

  // Check if within grace period (3s after wrap-up shows)
  const now = Date.now();
  const timeSinceCompletion = now - completedAt;

  // If more than 3s since completion, commit the wrap-up
  if (timeSinceCompletion >= WRAP_UP_GRACE_PERIOD_MS) {
    return 'commit';
  }

  // Within grace period - rollback
  return 'rollback';
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
