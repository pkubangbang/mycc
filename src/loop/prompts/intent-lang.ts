/**
 * intent-lang.ts - Intent Language system-prompt section
 *
 * Builds the "## Intent Lang" section that teaches the LLM the
 * `VERB OBJECT [PARAM ...] TO PURPOSE` DSL used by the bash judge. Extracted
 * from common.ts so the section prose (which is large and self-contained)
 * lives in its own module. Imported directly by lead.ts and common.ts
 * (buildCommonSections).
 */

import {
  VALID_VERBS,
  VALID_OBJECTS,
  VERB_MEANINGS,
  OBJECT_MEANINGS,
} from '../../context/grant/intent-parser.js';

// ============================================================================
// Intent Language Section (shared across all prompts)
// ============================================================================

export function buildIntentLanguageSection(): string {
  // --- Intro ---
  const intro = [
    '## Intent Lang',
    'When a tool requires an `intent` parameter, you MUST speak the Intent Lang. The Intent Lang follows this format strictly:',
    '```',
    'VERB OBJECT [PARAM PARAM ...] TO PURPOSE',
    '```',
    'where each `PARAM` is a `key=value` pair to describe an aspect of the OBJECT. You choose the key.',
    'IMPORTANT: The VERB / OBJECT vocabulary is very limited, however you can not use words outside the vocabulary.',
  ];

  // --- VERB table ---
  const verbTable = [
    '### VERB',
    '| Verb | Meaning |',
    '|------|---------|',
    ...VALID_VERBS.map((v) => `| ${v} | ${VERB_MEANINGS[v] || ''} |`),
    '',
  ];

  // --- OBJECT table ---
  const objectTable = [
    '### OBJECT',
    '| Object | Meaning |',
    '|--------|---------|',
    ...VALID_OBJECTS.map((o) => `| ${o} | ${OBJECT_MEANINGS[o] || ''} |`),
    '',
  ];

  // --- Mindflow ---
  const mindflow = [
    '### Mindflow',
    'The VERB + OBJECT is the backbone. PARAMs describe the OBJECT; the PURPOSE justifies the VERB. All parts must align with your actual intent.',
  ];

  // --- PARAM Syntax ---
  // Concrete syntax rules so the LLM does not emit malformed PARAMs (spaces in
  // values, comma-joined values, etc.) which the parser rejects with a retry
  // hint. Also show that the same key MAY repeat to enumerate multiple values.
  const paramSyntax = [
    '### PARAM Syntax',
    '- Each PARAM is exactly `key=value` — **one** `=`, **no spaces** around it or inside the value. The parser splits PARAMs on whitespace, so a value with a space breaks parsing.',
    '- Do NOT comma-join multiple values into one PARAM (e.g. `path=a,b,c` is wrong). Instead **repeat the same key** once per value: `path=a path=b path=c`. Repeated keys are the intended way to enumerate multiple values of the same kind.',
    '- Keys are lowercase snake_case (e.g. `dir`, `type`, `path`, `dangerous`). Values are bare tokens (no quotes, no spaces).',
    '- Example tracing multiple files of the state machine flow: `READ SOURCE path=src/loop/states/prompt.ts path=src/loop/states/collect.ts path=src/loop/states/llm.ts TO understand the state machine flow`',
  ];

  // --- Examples ---
  const examples = [
    '### Examples',
    '- `READ SOURCE dir=src type=.ts TO understand dependencies`',
    '- `RUN SYSTEM TO check git status`',
    '- `INSTALL DEPENDENCY TO set up project prerequisites`',
    '- `BUILD ARTIFACT TO verify compilation`',
    '- `WRITE CONFIG path=.env TO update environment settings`',
  ];

  // --- PARAM Conventions ---
  // Reserved PARAMs that the bash judge honors. Most PARAMs are free-form
  // descriptors (you choose the key), but the following reserved PARAMs change
  // how the command is judged:
  const dangerousLine =
    "- `dangerous=i_know` — **escape hatch for dangerous commands.** Some bash commands (e.g. `rm -rf`, force pushes, dropping tables) are blocked by default because they are destructive or irreversible. " +
    'If you genuinely intend such a command and understand the risk, declare `dangerous=i_know` in your intent. ' +
    "The system then **skips its own block AND skips its own LLM safeguard**, and routes the decision directly to the user via a `[y/N]` confirmation. " +
    "The human's approval is the real authorization — your declaration only honestly acknowledges the risk.";

  const batchLine =
    "- `batch=i_know` — **skip the LLM safeguard for batch deletions.** A `DELETE` command that targets multiple files / globs / recursive paths (e.g. `rm -rf node_modules/`, `rm a b c`, `find . -delete`) is normally sent to an LLM classifier (SAFE / DANGEROUS / UNCERTAIN) before possibly asking the user — costing latency and tokens even for obvious-safe cleanup. " +
    'If you know the deletion is a batch operation, declare `batch=i_know` to **skip the LLM call** and route directly to the user `[y/N]`. ' +
    "The human's approval is the real authorization; your declaration only honestly names the operation type.";

  const paramConventions = [
    '### PARAM Conventions',
    'Most PARAMs are free-form descriptors — you choose the key to describe the OBJECT. A few reserved PARAMs change how the bash judge routes the command:',
    '',
    dangerousLine,
    '  - Only affects `destructive` and `irreversible` categories. The `system` category (e.g. `git commit`, `npm publish`) is a routing nudge, NOT a danger gate — it stays hard-blocked with no escape hatch (use the dedicated tool, e.g. `git_commit`, instead).',
    '  - Unavailable in child processes: a child cannot reach the user prompt, so `dangerous=i_know` is rejected there — ask the lead agent to perform the operation instead.',
    '  - Without this PARAM, a blocked dangerous command returns a Socratic Hint that names the *existence* of a PARAM override but withholds the exact key/value; you must consult this section to find it.',
    '  - Example: `DELETE DATA path=build/ dangerous=i_know TO reclaim disk space before rebuild`',
    '',
    batchLine,
    '  - Only affects the `DELETE` + batch-delete path. It does NOT bypass a hard block (batch deletion is not hard-blocked — it is LLM-judged), and it does NOT cover the catastrophic patterns handled by `dangerous=i_know` (those match the dangerous-command check first and never reach the batch path).',
    '  - Unavailable in child processes: a child cannot reach the user prompt, so `batch=i_know` is rejected there — ask the lead agent to perform the operation instead.',
    '  - Example: `DELETE TEMP batch=i_know TO clean build artifacts before rebuild` (for `rm -rf dist/ node_modules/`)',
  ];

  return [
    ...intro,
    ...verbTable,
    ...objectTable,
    ...mindflow,
    ...paramSyntax,
    ...examples,
    ...paramConventions,
  ].join('\n');
}