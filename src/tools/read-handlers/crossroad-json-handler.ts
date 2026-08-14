/**
 * crossroad-json-handler.ts - Handler for crossroad record JSON files
 *
 * A crossroad record file (written by llm.ts to
 * `.mycc/sessions/<sessionId>/crossroad-<timestamp>.json`) captures the full
 * decision behind a crossroad resolution:
 *   { sessionId, timestamp, prefix, candidates[], continuation }
 *
 * When the LLM calls read_file with aloud=true on such a file (e.g. the user
 * asked to "replay" a crossroad decision), this handler:
 *   - Merges prefix + continuation into a single readable text block as the
 *     displayText (shown to the terminal via brief).
 *   - Returns a SHORT confirmation as the toolResult (what the LLM sees).
 *
 * This is the replay-bypass mechanism: the full reconstructed response reaches
 * the terminal WITHOUT the LLM regenerating it. Because the display happens
 * through brief (role='tool' result path) and is NOT placed in
 * chat.assistantContent, detectTurningWord — which only scans
 * chat.assistantContent — never sees the reconstructed text, so reading the
 * file aloud cannot re-trigger the crossroad. The LLM only receives the short
 * confirmation, so it has nothing to regenerate either.
 */

import type { FileHandler, FileHandlerResult } from '../read-handlers.js';

/**
 * Shape of the crossroad record file written by llm.ts.
 */
interface CrossroadRecord {
  sessionId?: string;
  timestamp?: number;
  prefix?: string;
  candidates?: string[];
  continuation?: string;
}

/**
 * Crossroad JSON file handler.
 *
 * matches():
 *   1. Cheap suffix quick-check — file must end in `.json` (avoids parsing
 *      every file read_file opens).
 *   2. Content check — parse as JSON and verify the crossroad signature fields
 *      (prefix, candidates, continuation) are present. sessionId/timestamp
 *      are optional for forward-compatibility, but the three core fields
 *      identify an unambiguous crossroad record.
 *
 * process():
 *   Merges prefix + continuation into displayText (what the terminal shows).
 *   Returns a short toolResult naming the file and candidate count so the LLM
 *   knows what was replayed without holding the full text.
 */
export const crossroadJsonHandler: FileHandler = {
  matches(filePath: string, content: string): boolean {
    // Suffix quick-check — fail fast on non-JSON files.
    if (!filePath.endsWith('.json')) return false;

    // Content check — parse and verify crossroad signature.
    try {
      const parsed = JSON.parse(content) as CrossroadRecord;
      return typeof parsed.prefix === 'string'
        && Array.isArray(parsed.candidates)
        && typeof parsed.continuation === 'string';
    } catch {
      return false;
    }
  },

  process(filePath: string, content: string): FileHandlerResult {
    let record: CrossroadRecord;
    try {
      record = JSON.parse(content) as CrossroadRecord;
    } catch {
      // Should not happen (matches() already validated), but stay safe.
      return { toolResult: content, displayText: content };
    }

    const prefix = record.prefix ?? '';
    const continuation = record.continuation ?? '';
    const candidates = record.candidates ?? [];

    // Reconstruct the full response the user would have seen: the prefix the
    // LLM wrote before the turning word, followed by the selected continuation.
    // A blank line separates them for readability in the terminal.
    const displayText = `${prefix}\n\n${continuation}`;

    // Short confirmation returned to the LLM. It learns that a crossroad
    // decision was replayed to the terminal, with enough metadata (candidate
    // count) to answer follow-ups — but NOT the full reconstructed text, so it
    // has nothing to echo back and no turning words to regenerate.
    const toolResult = `Crossroad decision replayed to terminal from ${filePath}.\n` +
      `Record summary: ${candidates.length} candidate continuation(s) were considered; the selected one was appended to the prefix and displayed aloud.\n` +
      `The full reconstructed text (prefix + continuation) was shown to the terminal user via brief; it is not re-injected into the conversation.`;

    return { toolResult, displayText };
  },
};