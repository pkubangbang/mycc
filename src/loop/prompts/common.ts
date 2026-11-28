/**
 * common.ts - Shared system-prompt building blocks
 *
 * Section builders used by both the lead prompts (lead.ts) and the teammate
 * prompt (teammate.ts). Role-specific prompt assembly lives in those files;
 * this module holds the reusable prose sections (verification, launch args,
 * pinned todos), the Agent Memory section variants (lead/teammate) built on
 * shared conceptual axes, and the buildCommonSections assembly used by the
 * normal-mode prompts. The intent-language section lives in intent-lang.ts.
 *
 * The output-behavior rules (how to phrase replies, high-quality
 * explanations, the brief contract) DO live here, in buildOutputBehaviorSection(),
 * and are delivered to lead AND teammates through buildCommonSections(). They
 * were briefly relocated to the root AGENTS.md as project policy, but they are
 * harness mechanics shared by every agent, so a project restating them was pure
 * duplication: one copy here, one delivery path. Project-owned prose still
 * belongs in the project's AGENTS.md (injected verbatim by the project-context
 * populator).
 */

import { getLaunchArgs } from '../../config.js';
import { buildIntentLanguageSection } from './intent-lang.js';

// ============================================================================
// Common Sections (shared across prompts)
// ============================================================================

/**
 * The agent's speaking rules: how a reply is shaped, what a `brief` is, and how
 * an explanation must be argued.
 *
 * ROLE-AGNOSTIC — deliberately rendered by buildCommonSections(), so both the
 * lead and teammate prompts receive it. These are harness mechanics (every
 * agent in this program speaks to a human through the same channel), not
 * project policy, so a project should not be able to retune them from its own
 * AGENTS.md, and they must not be duplicated there: one copy, one delivery
 * path. Project-owned prose still belongs in the project's AGENTS.md, which
 * the project-context populator injects verbatim.
 */
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
    '### How to Shape a Reply and an Explanation',
    'These govern how you SPEAK; they never change what you DO.',
    '**Before output**, double check the resources you used to ensure they exist.',
    '',
    "1. **Match the user's language.** Reply in the same language as the user's query (Chinese query → Chinese reply, English query → English reply), even when the code, docs, or tool output are in another language. Only code, identifiers, paths and commands stay verbatim.",
    '2. **Start with the conclusion.** Open with what changed or what you recommend in ONE line before any explanation.',
    '3. **Provide your evidence.** Each argument should cover a distinct aspect, and together they should fully support your conclusion.',
    '4. **Speak positively; never interleave fault analysis.** Lead with what was achieved and verified. Report faults, causes and limits in a SEPARATE block with their effect and next step, not woven into the narrative — alternating success and failure sentence by sentence is hard to read.',
    '5. **Outline the difference.** Use "BEFORE / AFTER" to say it clearly.',
    '6. **No filler narration.** "Let me take a look...", "I can see that...", "What this does is..." → delete these. Just say what the result is.',
    '',
    '### Write What Holds Now, Not How It Got There',
    'Code comments and live docs describe the **current** invariant only. The story of how it was discovered — "previously this was…", "we changed it because…", what a reviewer corrected — costs every future reader context at the call site and buys nothing there. Record it in the `pitfall` wiki domain instead (`wiki_prepare` → `wiki_put`, one doc per event, 10-1000 tokens, three parts: trigger condition / what went wrong / what holds now).'
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
    'It identifies repo type, project shape, and available executables.'
  ].join('\n');
}

// ============================================================================
// Pinned Todo & Prevent-Stop Guard Section (lead-only — teammates never see it)
// ============================================================================

export function buildPinnedTodoSection(): string {
  return [
    '### Pinned Todos',
    'Regular todos are ruled out the moment they are completed (ad-hoc: a done non-pinned item ' +
      'disappears immediately). Pinned todos persist:',
    '- Use `todo_pinning(id, hash, pinned=true)` to pin a todo after creating it with `todo_create`.',
    '- Completion is IRREVERSIBLE for a regular todo: once ruled out it is gone from the list, and ' +
      '`todo_update` / `todo_pinning` on its id then fail with "not found". Re-create it with ' +
      '`todo_create` if the work is genuinely not done.',
    '- Pinned todos are NOT dropped when they are completed — they persist as long-term reminders. ' +
      'Unpinning a completed pinned todo rules it out (the retention rule applies to that write too).',
    '- Use pinned todos for persistent reminders (e.g., schema definitions, invariant rules, ' +
      'materialized view refresh tasks).',
    '',
    '### Prevent-Stop Guards',
    'A pinned todo can carry a `preventStop` guard — a statement about the state the work must ' +
      'reach before you may finish your turn:',
    '- Set it with `todo_pinning(id, hash, pinned=true, preventStop="<condition>")`.',
    '- At every STOP, the system evaluates ALL guards in one batched LLM call against the conversation.',
    '- While a guard holds, you CANNOT end the turn: you get a `[STOP BLOCKED]` SYSTEM note and are ' +
      'sent back to work with what is still missing.',
    '- Repeated holds escalate, naming the hold count and the release call.',
    '- Release a guard you no longer need (or once it is satisfied) with ' +
      '`todo_pinning(id, hash, pinned=false)` — the system never releases it for you.',
    '- Judge-proof wording matters: state a verifiable outcome, not an intention. Example: ' +
      '`todo_pinning(id=2, hash="abc12345", pinned=true, ' +
      'preventStop="the failing test in todo.test.ts passes and pnpm lint is clean")`'
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
    "- Don't create or edit `.gitignore` unless the task requires it — just keep `.mycc/` out of commits."
  ].join('\n');
}

// ============================================================================
// Shared Common Sections (used by all normal mode prompts)
// ============================================================================

export function buildCommonSections(): string {
  // Output Behavior is shared by lead AND teammates: it is harness mechanics,
  // not project policy, so it is delivered here (once) instead of from a
  // project's AGENTS.md, where every project would have to restate it.
  return [
    buildLaunchArgsSection(),
    '',
    buildProjectIgnoreSection(),
    '',
    buildVerificationSection(),
    '',
    buildIntentLanguageSection(),
    '',
    buildOutputBehaviorSection()
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
  'State is either ephemeral (working tracking, background tasks) or persisted (tasks, knowledge base, skills) — persisted state survives across turns.'
];

/**
 * Lead agent-memory section. Adds lead-only coordination (teammates, peers)
 * and communication channels on top of the shared axes. The lead reaches the user through the `agent >>` prompt,
 * NOT via a tool — so `question` is absent here (it is child-only).
 */
export function buildLeadAgentMemorySection(): string {
  return [
    '## Agent Memory',
    'You have structured capability modules beyond basic file I/O. They organize along a few conceptual axes:',
    ...commonAxes,
    'You also coordinate: spawn/await teammates, broadcast, and discover peer instances.',
    'Communication is async (mail_to), status (brief), or topic-shift (mycc_title).',
    '',
    buildBriefSection()
  ].join('\n');
}

// ============================================================================
// Briefs Section (lead-only — teammates must never see it)
// ============================================================================

/**
 * The brief contract, stated ONLY here and in the `brief` tool's description.
 *
 * Lead-only by construction: this builder is called from
 * buildLeadAgentMemorySection() only. The teammate prompt assembles
 * buildTeammateAgentMemorySection() + buildCommonSections(), neither of which
 * reaches it.
 */
export function buildBriefSection(): string {
  return [
    '## Briefs',
    'A `brief` is a checkpoint the user reads AND the durable record of where an exploration stands. Emit it as the SOLE tool call of its turn (conclusion first, then evidence), then keep working.'
  ].join('\n');
}

// ============================================================================
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
    'You can interrupt and ask the user directly via question; you do not coordinate teammates or peers.'
  ].join('\n');
}
