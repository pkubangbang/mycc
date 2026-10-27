/**
 * common.ts - Shared system-prompt building blocks
 *
 * Section builders used by both the lead prompts (lead.ts) and the teammate
 * prompt (teammate.ts). Role-specific prompt assembly lives in those files;
 * this module holds the reusable prose sections (output behavior,
 * verification, launch args, pinned todos), the Agent Memory section variants
 * (lead/teammate) built on shared conceptual axes, and the
 * buildCommonSections assembly used by the normal-mode prompts. The
 * intent-language section lives in intent-lang.ts.
 */


import { getLaunchArgs } from '../../config.js';
import { buildIntentLanguageSection } from './intent-lang.js';

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
// Project Ignore Section (shared across all prompts)
// ============================================================================

/**
 * Remind the agent to keep mycc's runtime folder (`.mycc/`) out of version
 * control. This replaces the former `ensureGitignore()` auto-writer that
 * silently edited the user's `.gitignore` on every startup: editing a tracked
 * file without being asked is surprising, and it only ever worked INSIDE a git
 * repo. Instead the agent is now told the rule and applies it when — and only
 * when — the task actually touches version control.
 *
 * `.mycc/` is mycc's per-project runtime sandbox (sessions, tools, skills,
 * longtext/imgcache output) and is not meant to be committed.
 */
export function buildProjectIgnoreSection(): string {
  return [
    '## Project Ignore',
    'mycc stores its per-project runtime state in the `.mycc/` folder (sessions, tools, skills, tool caches).',
    'It must NOT be committed to version control.',
    '- If `.mycc/` is not already ignored (check `.gitignore`) and you are doing version-control work, add `/.mycc/*` to `.gitignore`.',
    '- Prefer `/.mycc/*` (contents-only) over `/.mycc/` (whole-dir): the former still lets a negation pattern (e.g. `!.mycc/skills/`) track a specific subfolder later.',
    '- Don\'t create or edit `.gitignore` unless the task requires it — just keep `.mycc/` out of commits.',
  ].join('\n');
}

// ============================================================================
// Shared Common Sections (used by all normal mode prompts)
// ============================================================================

export function buildCommonSections(): string {
  return [
    buildLaunchArgsSection(),
    '',
    buildProjectIgnoreSection(),
    '',
    buildVerificationSection(),
    '',
    buildIntentLanguageSection(),
    '',
    buildOutputBehaviorSection(),
  ].join('\n');
}

// ============================================================================
// Agent Memory Sections (capability architecture — spirit, not tool catalog)
// ============================================================================

/**
 * Shared conceptual axes for both lead and teammate agent-memory sections.
 * Ranked by behavioral value: knowledge-priority first (most behavior-changing),
 * execution-scope second, persistence third. Each axis is one line — a short
 * clause naming the axis + the conceptual contrast, NOT a tool catalog. The
 * LLM already sees the tool schemas; this section gives it the mental model
 * to organize them.
 *
 * The knowledge axis folds in the concrete usage hints that used to live in
 * the standalone Knowledge Boundary section (now removed), so this section is
 * the single home for both the mental model AND the actionable "how to use"
 * detail. The dynamic skill-keywords list was moved out of the byte-stable
 * system prompt entirely — it is now passed into the extractKeywords() LLM
 * call (suggestSkill in collect.ts step 6) as a system-message
 * input, so the LLM selects relevant keywords from the actual available
 * list based on the X+Y+Z composite, instead of a separate always-on
 * project-context populator that broke the prompt-cache prefix on every
 * skill reload.
 */
const commonAxes = [
  'Knowledge is layered by priority — check local sources FIRST, web LAST: recall(path="/") explores the mindmap knowledge tree (START HERE for project context); skill_search discovers on-demand specialist skills; wiki_get queries the persistent RAG store; web_search/web_fetch are the last resort, not the first.',
  'Work happens at three scopes: solo (direct file/command tools), team (in-process teammates via messaging), and cross-instance (separate mycc processes).',
  'State is either ephemeral (working tracking, background tasks) or persisted (tasks, knowledge base, skills) — persisted state survives across turns.',
];

/**
 * Lead agent-memory section. Adds lead-only coordination (teammates, peers,
 * context folding) and communication channels on top of the shared axes. The
 * lead reaches the user through the `agent >>` prompt, NOT via a tool — so
 * `question` is absent here (it is child-only).
 */
export function buildLeadAgentMemorySection(): string {
  return [
    '## Agent Memory',
    'You have structured capability modules beyond basic file I/O. They organize along a few conceptual axes:',
    ...commonAxes,
    'You also coordinate: spawn/await teammates, broadcast, discover peer instances, and fold finished work out of your own context (see "Briefs and Folding" below).',
    'Communication is async (mail_to), status (brief), or topic-shift (mycc_title).',
    '',
    buildBriefRecapSection(),
  ].join('\n');
}

// ============================================================================
// Briefs and Folding section (lead-only — teammates must never see it)
// ============================================================================

/**
 * The fold contract, stated ONLY here. It must never go into `brief`'s tool
 * description: `brief` is `scope: ['main', 'child']`, so every teammate
 * receives that description, and a teammate's span is never folded. Teaching a
 * child about a fold it cannot incur is a pure distraction.
 *
 * WHAT THE MODEL NEEDS TO KNOW, and nothing more:
 *   - its `brief` calls divide its session into chunks;
 *   - finished chunks MAY be replaced by a `[RECAP]` note, chosen for it;
 *   - the note is authoritative state, not a suggestion;
 *   - it should therefore write briefs that stand on their own.
 *
 * WHAT IT MUST NOT BE TOLD: a hash, a fold call, an addressable boundary. The
 * decision is made outside the conversation (`recap-signal.ts`) precisely
 * because the model would not make it; an address it could act on would be an
 * affordance pointing at a deleted tool.
 *
 * Lead-only by construction: this builder is called from
 * buildLeadAgentMemorySection() only. The teammate prompt assembles
 * buildTeammateAgentMemorySection() + buildCommonSections(), neither of which
 * reaches it (src/tests/loop/prompts/brief-recap-scope.test.ts guards this).
 */
export function buildBriefRecapSection(): string {
  return [
    '## Briefs and Folding',
    'Your `brief` calls divide this session into **chunks** of work. A chunk that is finished may be folded away: everything after that brief is replaced by a `[RECAP]` note.',
    '- You do not choose when this happens — a context manager outside the conversation decides, from the shape of the session, and does it just before one of your briefs is recorded. Expect a fold without asking for it, and do not try to invoke one.',
    '- A `[RECAP]` note is **authoritative state**, not a suggestion: it is the whole record of the work that was folded. Read it as your current situation and continue from it.',
    '- Write every brief so it can stand alone: conclusion first, then the evidence that matters. It is the boundary a fold cuts at, and the note that replaces the span builds on it.',
    '- Compaction is the floor: a fold never reaches back past the last compaction.',
  ].join('\n');
}

/**
 * Teammate agent-memory section. Adds the child-only `question` tool (the
 * teammate's unique channel to the user) on top of the shared axes. The
 * teammate has no team coordination, no peers, no context compression, no
 * plan mode — those are the lead's.
 */
export function buildTeammateAgentMemorySection(): string {
  return [
    '## Agent Memory',
    'You have structured capability modules beyond basic file I/O. They organize along a few conceptual axes:',
    ...commonAxes,
    'You can interrupt and ask the user directly via question; you do not coordinate teammates or peers.',
  ].join('\n');
}



