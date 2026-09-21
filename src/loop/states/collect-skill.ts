/**
 * collect-skill.ts - Proactive skill discovery, owned by a singleton.
 *
 * Step 6 of the COLLECT pipeline: composite keyword extraction + branching
 * skill suggestion. Composes a composite text from three sources
 * (brief + query + hint), extracts English keywords + a free-form semantic
 * query via a single LLM call, matches keywords against loaded skills, then
 * branches:
 *  - Branch A (small match <5): injects the full keyword-matched list.
 *  - Branch B (oversize >=5): refines via a wiki semantic-search
 *    intersection (fail-fast on empty freeformQuery; no hint on empty
 *    intersection or wiki failure).
 *
 * The discovery throttle state — the query dedup cursor (`lastQuery`) and
 * the cooldown counter (`cooldown`) — lives ON THIS SINGLETON, not on
 * TurnVars. The state machine calls `skillSuggester.reset()` at each turn
 * boundary (the same lifecycle points where the fields used to be
 * re-initialized on TurnVars). This mirrors the auto-state.ts precedent:
 * centralize mutable per-process state in a dedicated singleton so there is
 * a single source of truth.
 *
 * Three sources of the composite:
 *   brief = turn.lastBriefMessage   (agent's self-reported focus, set in TOOL)
 *   query = firstSteerNote ?? turn.lastUserQuery  (the trigger source)
 *   hint  = turn.lastHintFocus      (hint round focus_on, captured in step 3)
 * Extraction is TRIGGERED only by a change in query. Brief and hint enrich
 * the composite but never trigger. A 3-pass cooldown suppresses
 * re-triggering from consecutive user messages.
 *
 * See docs/plan-composite-keyword-extraction.md for the brief+query+hint design.
 */

import type { MachineEnv, TurnVars } from '../state-machine.js';
import { getSkillMatchThreshold } from '../../config.js';
import { loader } from '../../context/shared/loader.js';
import { getSkillTriologueStatus } from '../../utils/skill-dedup.js';
import type { Skill } from '../../types.js';
import type { Triologue } from '../triologue.js';
import { extractKeywords } from '../keyword-extractor.js';

/**
 * When the keyword-matched skill count reaches this threshold, the
 * suggestion is "oversize" — listing all matches (with descriptions) wastes
 * tokens. Instead, a semantic-search intersection refines the list to the
 * skills BOTH keyword-matched AND embedding-relevant. Below the threshold,
 * the full keyword-matched list is surfaced as before (small enough to be
 * useful inline). See runKeywordExtraction step 6, Branch B.
 */
const SKILL_OVERSIZE_THRESHOLD = 5;
/**
 * topK for the semantic wiki.get call in the oversize branch. Broader than
 * skill_search's topK=3 so the intersection with keyword matches has room
 * to be non-empty; the keyword match already acts as a precision filter.
 */
const SKILL_SEMANTIC_TOPK = 10;

/**
 * Partition a list of skills into new/suggested/loaded (via
 * getSkillTriologueStatus) and inject a HINT note surfacing them.
 *
 * Shared by both branches of runKeywordExtraction step 6:
 *  - Branch A (small match): the full keyword-matched list.
 *  - Branch B (oversize): the keyword∩semantic intersection.
 *
 * New skills are listed with their description; suggested/loaded skills are
 * listed by name only. The note always ends with the skill_search pointer
 * and the silent-nudge discipline reminder.
 */
function injectSkillHint(triologue: Triologue, skills: Skill[]): void {
  if (skills.length === 0) return;

  const newSkills: string[] = [];
  const suggestedSkills: string[] = [];
  const loadedSkills: string[] = [];

  for (const skill of skills) {
    const status = getSkillTriologueStatus(triologue, skill);
    switch (status) {
      case 'new': {
        const desc = skill.description ? ` (${skill.description})` : '';
        newSkills.push(`${skill.name}${desc}`);
        break;
      }
      case 'suggested':
        suggestedSkills.push(skill.name);
        break;
      case 'loaded':
        loadedSkills.push(skill.name);
        break;
    }
  }

  const lines: string[] = [];
  if (newSkills.length > 0) {
    lines.push(`New relevant skills: ${newSkills.join(', ')}. Use skill_load(name="<exact_name>") to load them.`);
  }
  if (suggestedSkills.length > 0) {
    lines.push(`Also suggesting: ${suggestedSkills.join(', ')}. Use skill_load(name="<exact_name>") to load it.`);
  }
  if (loadedSkills.length > 0) {
    lines.push(`The below skills are loaded and also relevant: ${loadedSkills.join(', ')}.`);
  }
  lines.push('Note: you can also use skill_search to search for skills semantically.');
  // This is a silent nudge: either load a skill that genuinely helps the
  // current task (via skill_load), or ignore it and keep working. Do NOT
  // write a prose reply explaining why you are/aren't loading a skill —
  // that clutters the conversation and re-triggers the same nudge.
  lines.push('Discipline: this is a silent nudge. If a skill helps the current task, load it with skill_load; otherwise stay silent and continue. Do NOT narrate your decision.');

  triologue.note('HINT', lines.join('\n'));
}

/**
 * Strip the "<scope>:" prefix from a wiki skill title to get the bare skill
 * name. Wiki titles use the format "<scope>:<skill-name>" (e.g.
 * "project:code-review"); a title without a colon is returned as-is.
 * Mirrors the logic in skill_search.ts.
 */
function baseSkillNameFromWikiTitle(title: string): string {
  return title.includes(':') ? title.split(':').slice(1).join(':') : title;
}

/**
 * SkillSuggester - Singleton owning the proactive skill-discovery logic and
 * its throttle state.
 *
 * The discovery throttle (the query dedup cursor + cooldown) previously lived
 * on TurnVars as `lastSkillY` / `skillDiscoveryCooldown`. It now lives here
 * so the suggester is the single source of truth for its own state, matching
 * the auto-state.ts precedent (centralize mutable per-process state in a
 * dedicated singleton). The state machine calls `reset()` at each turn
 * boundary — the same lifecycle points where the fields were previously
 * re-initialized on TurnVars.
 *
 * Lifetime: process-wide. A single shared `skillSuggester` instance is
 * exported. Child processes (teammates) run their own COLLECT but never
 * share this instance (separate process = separate module = separate
 * singleton), which is correct: a teammate's discovery state must not leak
 * into the lead's.
 */
export class SkillSuggester {
  /** Query value used in the last extraction, for change detection. */
  private lastQuery = '';
  /** Cooldown counter: suppresses extraction for N COLLECT passes after firing. */
  private cooldown = 0;

  // ── State lifecycle ───────────────────────────────────────────────────

  /**
   * Reset the throttle state to a fresh-turn baseline. Called by the state
   * machine at every turn boundary (PROMPT/AWAIT from non-SLASH), mirroring
   * the old TurnVars re-initialization of `lastSkillY=''` + `cooldown=0`.
   */
  reset(): void {
    this.lastQuery = '';
    this.cooldown = 0;
  }

  /**
   * Decrement the cooldown counter by one (floored at 0). Called at the top
   * of each COLLECT pass so the cooldown naturally expires over N passes.
   */
  decrementCooldown(): void {
    if (this.cooldown > 0) this.cooldown--;
  }

  /**
   * Mark a query value as "seen" so it does not re-trigger extraction on
   * subsequent passes. Called on a success/skipped extraction outcome.
   */
  markQuerySeen(query: string): void {
    this.lastQuery = query;
  }

  /**
   * Arm the 3-pass cooldown. Called on a success/skipped extraction outcome
   * (the extraction ran, so suppress re-triggering for 3 passes).
   */
  armCooldown(): void {
    this.cooldown = 3;
  }

  /**
   * Clear the throttle state back to eligible (lastQuery='', cooldown=0).
   * Called on the Branch B fail-fast path (empty freeformQuery): the
   * extraction's success-path marking + cooldown-arming are undone so the
   * next pass re-attempts extraction. Mirrors the `failed` path: both leave
   * the query eligible and the cooldown at 0.
   */
  clearThrottle(): void {
    this.lastQuery = '';
    this.cooldown = 0;
  }

  // ── Read-only state queries ───────────────────────────────────────────

  /** Current query dedup cursor value (test-facing). */
  getLastQuery(): string {
    return this.lastQuery;
  }

  /** Current cooldown counter value (test-facing). */
  getCooldown(): number {
    return this.cooldown;
  }

  /**
   * Whether the query source changed this pass (non-null AND differs from
   * the last seen query). This is the extraction trigger condition.
   */
  queryChanged(query: string | null): boolean {
    return query !== null && query !== this.lastQuery;
  }

  /** Whether the cooldown is currently suppressing extraction. */
  cooldownActive(): boolean {
    return this.cooldown !== 0;
  }

  // ── Composite + gate logic ────────────────────────────────────────────

  /**
   * Compute the query source for a COLLECT pass. The steering note takes
   * precedence over lastUserQuery (freshest mid-task direction). Returns
   * null when neither is present.
   */
  computeQuerySource(steerNote: string | null, lastUserQuery: string): string | null {
    return steerNote ?? (lastUserQuery || null);
  }

  /**
   * Build the composite text from the three sources:
   *   brief = agent's self-reported focus (turn.lastBriefMessage)
   *   query = the trigger source (steering note ?? lastUserQuery)
   *   hint  = hint round focus_on (turn.lastHintFocus)
   * Empty sources are omitted; the remainder is joined with newlines.
   */
  buildCompositeText(brief: string, query: string | null, hint: string): string {
    const parts: string[] = [];
    if (brief) parts.push(brief);
    if (query) parts.push(query);
    if (hint) parts.push(hint);
    return parts.join('\n');
  }

  /**
   * Whether extraction should fire this pass. Requires a changed query, an
   * inactive cooldown, and a composite long enough to be meaningful (>= 4
   * chars after trim).
   */
  shouldExtract(queryChanged: boolean, cooldown: number, compositeText: string): boolean {
    return queryChanged && cooldown === 0 && compositeText.trim().length >= 4;
  }

  // ── Main entry ────────────────────────────────────────────────────────

  /**
   * Step 6: composite keyword extraction for proactive skill discovery.
   *
   * Composes a composite text from three sources:
   *   brief = turn.lastBriefMessage  (agent's self-reported focus, set in TOOL)
   *   query = firstSteerNote ?? turn.lastUserQuery  (the trigger source)
   *   hint  = turn.lastHintFocus  (hint round focus_on, captured in step 3)
   * Extraction is TRIGGERED only by a change in query. Brief and hint enrich
   * the composite but never trigger. A 3-pass cooldown suppresses
   * re-triggering from consecutive user messages.
   *
   * @param firstSteerNote - the freshest steering note drained this pass
   *        (from collectMailsAndInput), or null.
   *
   * Side effects on this singleton: `lastQuery` (query dedup cursor) and
   * `cooldown` — armed ONLY on a success/skipped outcome; a `failed`
   * outcome (ESC / transient) leaves query eligible for retry.
   */
  async runKeywordExtraction(env: MachineEnv, turn: TurnVars, firstSteerNote: string | null): Promise<void> {
    const { triologue, ctx } = env;

    this.decrementCooldown();

    const querySource = this.computeQuerySource(firstSteerNote, turn.lastUserQuery || '');
    const changed = this.queryChanged(querySource);

    // Build the composite text (brief + query + hint). Query is the trigger;
    // brief and hint enrich.
    const compositeText = this.buildCompositeText(
      turn.lastBriefMessage,
      querySource,
      turn.lastHintFocus,
    );

    if (!changed || this.cooldownActive() || compositeText.trim().length < 4) {
      return;
    }

    // Extract English keywords from the composite via LLM (ESC-safe).
    // extractKeywords returns a discriminated union so we can distinguish a
    // completed extraction (success/skipped) from a failed/aborted one:
    //   - success: the LLM ran; keywords may be empty. Arm the cooldown and
    //     mark query as seen.
    //   - skipped: the composite was trivial (greeting/ack). Mark query as
    //     seen so a trivial "hello" doesn't re-trigger every pass — but a
    //     subsequent meaningful query (different query content) still triggers.
    //   - failed: the call threw (transient network error or ESC abort).
    //     Do NOT arm the cooldown or mark query as seen: query stays
    //     eligible for a retry on a subsequent pass.
    // The escAware cleanup returns { status: 'failed' } on ESC, so the
    // abort path is handled by the same `failed` branch (preserving the
    // documented "ESC does not consume the discovery opportunity" retry
    // behavior that the old `[]`-returning API silently broke).
    const result = await ctx.core.escAware(
      async (ac) => extractKeywords(compositeText, loader.getSkillKeywords(), ac.signal),
      () => ({ status: 'failed' } as const),
    );

    if (result.status === 'failed') {
      // Query stays eligible for retry — do not touch lastQuery or cooldown.
      // (The cooldown was already decremented at the top of step 6, which is
      // fine: a failed attempt does not extend suppression.)
      return;
    }

    // success or skipped: mark the query source as "seen" so it doesn't
    // re-trigger. When a steering note was the trigger, ALSO mark the
    // fallback lastUserQuery as seen so it doesn't spuriously re-trigger
    // after the steering note is consumed on subsequent passes
    // (Review BUG 1 — spurious double-trigger).
    this.markQuerySeen(querySource!);
    if (firstSteerNote && turn.lastUserQuery) {
      this.markQuerySeen(turn.lastUserQuery);
    }
    this.armCooldown();

    // Only a successful extraction with real keywords can surface skills.
    // A `skipped` (trivial) outcome has no keywords, and a `success` with
    // an empty keywords array means the LLM found nothing relevant — both
    // fall through here without injecting a HINT note.
    const keywords = result.status === 'success' ? result.keywords : [];
    const freeformQuery = result.status === 'success' ? result.freeformQuery : '';
    if (keywords.length === 0) return;

    const allSkills = ctx.skill.listSkills();
    const matched = allSkills.filter(s => {
      const nameLower = s.name.toLowerCase();
      const kwLower = s.keywords.map(k => k.toLowerCase());
      return keywords.some(kw =>
        nameLower.includes(kw) ||
        kwLower.some(k => k.includes(kw) || kw.includes(k)),
      );
    });

    if (matched.length === 0) return;

    // ── Branching skill suggestion ──────────────────────────────────────
    // Branch A (small match): the keyword-matched list is small enough to
    //   surface inline with descriptions — inject it directly (the original
    //   behavior). No semantic-search refinement needed.
    // Branch B (oversize): too many keyword matches to dump inline (token
    //   bloat). Refine via a semantic-search intersection: call ctx.wiki.get
    //   with the free-form query, then keep ONLY the skills that BOTH
    //   keyword-matched AND appear in the semantic results. If the
    //   freeformQuery is invalid (empty), FAIL FAST — leave query eligible
    //   for a retry (do NOT mark lastQuery / arm cooldown) so the next pass
    //   re-attempts extraction. If the intersection is empty, no hint is
    //   injected (the signal is too weak to suggest anything).
    if (matched.length < SKILL_OVERSIZE_THRESHOLD) {
      // Branch A: small match — inject the full keyword-matched list.
      injectSkillHint(triologue, matched);
      return;
    }

    // Branch B: oversize — refine via semantic intersection.
    // The freeformQuery MUST be valid to start the matching; otherwise fail
    // fast and leave query eligible for retry on the next pass. Undo the
    // query-marking + cooldown-arming performed above so the next pass
    // re-attempts extraction (the LLM gets another chance to produce a
    // valid freeformQuery). This mirrors the `failed` path: both leave
    // lastQuery untouched-at-eligible and cooldown at 0.
    if (!freeformQuery || !freeformQuery.trim()) {
      this.clearThrottle();
      return;
    }

    // Semantic search via wiki (embedding-based). Graceful failure: if the
    // wiki call throws (no embedding model, transient error), no hint is
    // injected — the keyword match alone is too noisy at this scale to be
    // useful, so we stay silent rather than bloat the conversation.
    let semResults: Awaited<ReturnType<typeof ctx.wiki.get>>;
    try {
      semResults = await ctx.wiki.get(freeformQuery, {
        domain: 'skills',
        topK: SKILL_SEMANTIC_TOPK,
        threshold: getSkillMatchThreshold(),
      });
    } catch {
      // Semantic search unavailable — no hint (signal too weak to refine).
      return;
    }

    // Build a case-insensitive set of semantic skill names (strip the
    // "<scope>:" prefix from wiki titles to get bare skill names).
    const semanticNames = new Set<string>();
    for (const r of semResults) {
      const baseName = baseSkillNameFromWikiTitle(r.document.title).toLowerCase();
      if (baseName) semanticNames.add(baseName);
    }

    // Intersection: skills that BOTH keyword-matched AND are semantically
    // relevant. Order preserved from `matched` (deterministic).
    const intersection = matched.filter(s => semanticNames.has(s.name.toLowerCase()));

    // Empty intersection → no hint. Neither keyword matching nor semantic
    // search agree on any skill; the signal is too weak to suggest anything.
    if (intersection.length === 0) return;

    injectSkillHint(triologue, intersection);
  }
}

/**
 * Process-wide singleton. Owns the discovery throttle state (query dedup
 * cursor + cooldown); the state machine calls `reset()` at each turn
 * boundary. Single source of truth for skill-discovery state.
 */
export const skillSuggester = new SkillSuggester();