/**
 * crossroad.js — Crossroad record formatter for mycc-pretty-print
 *
 * Migrated from src/tools/read-handlers/crossroad-json-handler.ts.
 *
 * A crossroad record file (written by llm.ts to
 * `.mycc/sessions/<sessionId>/crossroad-<timestamp>.json`) captures the full
 * decision behind a crossroad resolution:
 *   { sessionId, timestamp, prefix, candidates[], continuation }
 *
 * This formatter merges prefix + continuation into a single readable text
 * block and outputs it to stdout, so the agent can replay the full
 * reconstructed response to the terminal user via:
 *
 *   bash(command="mycc-pretty-print --type=crossroad <path>", display=true)
 *
 * The display parameter briefs stdout to the terminal; detectTurningWord only
 * scans chat.assistantContent, so a tool result can never re-trigger the
 * crossroad — the replay is side-effect-free.
 */

import fs from 'fs';

/**
 * Format a crossroad record JSON file for terminal display.
 *
 * Reconstructs the full response the user would have seen: the prefix the
 * LLM wrote before the turning word, followed by the selected continuation.
 * A blank line separates them for readability.
 *
 * @param {string} filePath - absolute or relative path to the crossroad JSON file
 * @returns {string} the merged prefix + continuation text
 * @throws if the file cannot be read or parsed as a crossroad record
 */
export function format(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');

  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    throw new Error(`File is not valid JSON: ${filePath}`);
  }

  // Validate the crossroad signature: prefix, candidates, and continuation
  // must be present. sessionId/timestamp are optional for forward-compatibility.
  if (
    typeof record.prefix !== 'string' ||
    !Array.isArray(record.candidates) ||
    typeof record.continuation !== 'string'
  ) {
    throw new Error(
      `File is not a crossroad record (missing prefix/candidates/continuation): ${filePath}`
    );
  }

  const prefix = record.prefix;
  const continuation = record.continuation;

  // Reconstruct the full response: prefix (text before the turning word)
  // followed by the selected continuation. A blank line separates them.
  return `${prefix}\n\n${continuation}`;
}