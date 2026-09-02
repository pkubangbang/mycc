/**
 * common.ts - Shared system-prompt building blocks
 *
 * Section builders used by both the lead prompts (lead.ts) and the teammate
 * prompt (teammate.ts). Role-specific prompt assembly lives in those files;
 * this module holds only the reusable prose sections (output behavior,
 * verification, knowledge boundary, context management, launch args, pinned
 * todos) plus the plan-mode base prompt that the lead plan prompts compose on
 * top of. The intent-language section lives in intent-lang.ts and is
 * re-exported here for backward compatibility with existing callers.
 */

import { loader } from '../../context/shared/loader.js';
import { getLaunchArgs } from '../../config.js';
import { buildIntentLanguageSection } from './intent-lang.js';

// Re-export so existing imports from './common.js' keep working.
export { buildIntentLanguageSection };

// ============================================================================
// Common Sections (shared across prompts)
// ============================================================================

export function buildOutputBehaviorSection(): string {
  return [
    '## Output Behavior',
    '**CRITICAL**: you MUST follow these instructions when you respond.',
    '- When you detect dilemma, use the brief tool to state it clearly with a low confidence (1~5).',
    '- Avoid repeating the content that has been output by the brief tool.',
    '- Do NOT explain, comment on, or narrate your response to hook/skill [REMINDER] or [Hook] notifications. ' +
    'If a reminder tells you to do something, do it silently. ' +
    'If it is informational, acknowledge it implicitly by continuing your task.',
    '',
    '### High-Quality Explanations',
    '**Before output**, double check the resources you used to ensure they exist.',
    'When explaining code changes, design choices, or analysis results:',
    '',
    '1. Start with the conclusion - State what changed or what you recommend in ONE line before any explanation.',
    '2. Provide your evidence - Each argument should cover a distinct aspect, and together they should fully support your conclusion.',
    '3. Outline the difference - Use "BEFORE / AFTER" to say it clearly.',
    '4. Avoid filler narration - "Let me take a look...", "I can see that...", "What this does is..." → delete these. ' +
    'Just say what the result is.',
    '5. Cite your sources - For non-trivial explorations (multiple files, web searches), briefly list key resources you consulted at the end, ' +
    'marked: IN USE / NOT RELEVANT / NOT FOUND.',
  ].join('\n');
}

export function buildVerificationSection(): string {
  return [
    '## Verification Before Action',
    "Understand the project structure and the user's preference before acting. If unsure, ask — don't infer.",
    'Before adding code to enforce a requirement, check whether the code already enforces it.',
    '',
    '### Environment Detection',
    'If the project layout is unfamiliar, load the environment-detection skill:',
    '```',
    'skill_load(name="environment-detection")',
    '```',
    'It identifies repo type, project shape, and available executables.',
  ].join('\n');
}

// ============================================================================
// Pinned Todo & Reactivation Section (lead-only — teammates never see it)
// ============================================================================

export function buildPinnedTodoSection(): string {
  return [
    '### Pinned Todos',
    'Regular todos are auto-cleared when all are completed. Pinned todos persist:',
    '- Use `todo_pinning(id, hash, pinned=true)` to pin a todo after creating it with `todo_create`.',
    '- Pinned todos are NOT removed when all todos are completed.',
    '- Use pinned todos for persistent reminders (e.g., schema definitions, invariant rules, ' +
    'materialized view refresh tasks).',
    '',
    '### Reactivation',
    'Pinned todos can be automatically reactivated (marked back to not done) when a condition is met:',
    '- Use `todo_pinning(id, hash, pinned=true, reactivate="<natural language condition>")` to set a reactivation condition.',
    "- After each nudge cycle, the system evaluates completed pinned todos' reactivation conditions " +
    'against the conversation context via LLM.',
    '- If the condition is met, the todo is automatically reactivated — you will see a SYSTEM note about the reactivation.',
    '- Example: `todo_pinning(id=2, hash="abc12345", pinned=true, ' +
    'reactivate="when the users table or orders table is modified (INSERT/UPDATE/DELETE)")`',
  ].join('\n');
}

// ============================================================================
// Launch Args Section (shared across all prompts)
// ============================================================================

/**
 * Expose the launch argv (sanitized — secrets redacted) so the LLM can
 * self-identify how it was started. A daemon Lead sees
 * `--daemon lfplater-skill-manager --skip-healthcheck` and knows its role; a
 * normal lead sees `(none)`. Generic — no `if (role)` special-casing.
 */
export function buildLaunchArgsSection(): string {
  return `## Launch Args\nYou were started with: \`${getLaunchArgs()}\``;
}

// ============================================================================
// Shared Common Sections (used by all normal mode prompts)
// ============================================================================

export function buildCommonSections(): string {
  return [
    buildLaunchArgsSection(),
    '',
    buildVerificationSection(),
    '',
    buildIntentLanguageSection(),
    '',
    buildOutputBehaviorSection(),
  ].join('\n');
}

// ============================================================================
// Knowledge Boundary Section
// ============================================================================

export function buildKnowledgeBoundarySection(): string {
  const base = [
    '## Knowledge Boundary',
    '',
    'You have access to these knowledge sources (in priority order):',
    '- **Recall**: Explore the mindmap knowledge tree. Use `recall(path="/")` to discover available knowledge. ' +
    'START HERE for project context.',
    '- **Skills**: Specialized knowledge for specific tasks. Use `skill_search(search="...")` to discover relevant skills.',
    '- **Web**: External information from the internet. Use `web_search(query)` and `web_fetch(url)` as LAST RESORT.',
    '',
    '**Priority Rule**: Always check local knowledge sources (Recall → Skills) BEFORE searching the web.',
    'Local sources are faster, more accurate for this project, and always available.',
    'Use web_search only when:',
    '- No local knowledge matches your query',
    '- You need the latest information (e.g., current library versions)',
    '- You need external documentation not in the project',
  ];

  const keywords = loader.getSkillKeywords();
  if (keywords.length === 0) {
    return base.join('\n');
  }

  const keywordsBlock = [
    '',
    '### Skill Keywords',
    '',
    `Available skill keywords: \`${keywords.join('`, `')}\``,
    '',
    'If your current task is relevant to or exactly matches any of these keywords, **proactively** use `skill_search(search="<keyword>")` ' +
    'to discover relevant skills before proceeding with a generic approach.',
  ];
  return [...base, ...keywordsBlock].join('\n');
}

export function buildContextManagementSection(): string {
  return [
    '## Checkpoint and recap',
    '',
    'Checkpoint and recap tools work together to manage subtask boundaries and keep you focused.',
    '',
    '**When to use checkpoint:**',
    '- Before reading multiple files to understand a codebase',
    '- Before investigating a bug or issue',
    '- Before doing experiments to proof the concept',
    '',
    '**When NOT to use checkpoint:**',
    '- Quick single-file edits',
    '- Simple lookups (one file, one command)',
    '- Tasks where you immediately know the answer',
    '',
    '**Workflow:**',
    '1. Use checkpoint tool to create a checkpoint with an ID (e.g., "abc12345")',
    '2. [Explore files, read code, investigate] - Messages accumulate',
    '3. Close the checkpoint with one of two options:',
    '   - recap({ checkpoint_id: "abc12345" }) - Summarize findings and close',
    '   - recap({ checkpoint_id: "abc12345", abandon: true }) - Discard and close',
    '4. Continue with clean context',
    '',
    '**Rules:**',
    '- Only ONE open checkpoint at a time',
    '- Checkpoint must be called ALONE (no other tools in same turn)',
    '- Use the checkpoint ID from step 1 when calling recap',
    '',
    '**Optional comment:**',
    'You can add a `comment` property to recap to record your findings, like:',
    '- recap({ checkpoint_id: "abc12345", comment: "Found that the bug is in the parser; next step is to update the tokenizer." })',
    '',
    'The comment is shown in the recap log for user visibility.',
    '',
    '**Required if_abandoned (checkpoint):**',
    'You MUST declare your original direction when creating a checkpoint:',
    '- checkpoint({ description: "...", if_abandoned: "Investigate the parser to find the bug source." })',
    'If you later abandon this checkpoint, the direction is presented heuristically in the abandon note: ' +
    '"the original direction was X; compare it with the current context and find your path." ' +
    'This preserves continuity when the exploration is discarded.',
  ].join('\n');
}

