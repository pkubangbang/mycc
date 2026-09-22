/**
 * collect-skill.ts - Proactive skill discovery, owned by a singleton.
 *
 * Step 6 of the COLLECT pipeline: composite keyword extraction + SCORED
 * skill ranking. Composes a composite text from three sources
 * (brief + query + hint), extracts significance-ORDERED English keywords +
 * a free-form semantic query via the SHARED LLM extractor
 * (`extractKeywords`, src/loop/keyword-extractor.ts — also used by the
 * `skill_search` tool, so on-demand search and the proactive nudge rank
 * identically), then scores every loaded skill and injects the top 3 as a
 * HINT note.
 *
 * SCORING (the pinned contract, shared with skill_search):
 *   1. Positional points — for each significance-ordered query keyword
 *      kw[i] (i < 5), every skill owning kw[i] (exact case-insensitive
 *      token membership) earns WEIGHTS[i] points: [10, 7, 5, 3, 2] for the
 *      1st..5th keyword (Motor-racing style). Keywords beyond the 5th are
 *      ignored. `points > 0` is a HARD precondition, so a pure-semantic
 *      skill can never surface (0 × anything = 0).
 *   2. Semantic boost — `boost = 1 + (sim - getSkillMatchThreshold())`, i.e.
 *      neutral (1.0) at the similarity threshold, rising linearly
 *      (0.7 → 1.2, 0.9 → 1.4). A keyword-matched skill that misses the
 *      semantic window (or a failed wiki call) keeps boost 1.0 — it is
 *      NEVER excluded on semantic grounds (soft boost, not intersection).
 *   3. score = points × boost; keep score > 10 STRICT; sort desc; take the
 *      top 3.
 * Because points ≥ 12 passes unconditionally (12 × 1.0 > 10) and points ≤ 5
 * can never pass, the gate makes keyword-strong matches stand alone while
 * letting a 7–10 point match ride a genuine semantic hit.
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
import type { Skill, Message } from '../../types.js';
import type { Triologue } from '../triologue.js';
import { extractKeywords, type KeywordExtractionResult } from '../keyword-extractor.js';

/**
 * Positional weights for the 1st..5th significance-ordered query keyword.
 * The 1st (most discriminative) keyword is worth 10; the 5th is worth 2.
 * Keywords beyond the 5th are ignored by the scorer. Mirrors the constant in
 * skill_search.ts — both consumers must weight positions identically.
 */
const KEYWORD_WEIGHTS = [10, 7, 5, 3, 2] as const;

/** Minimum total score to surface a skill (STRICT greater-than). */
const SKILL_SCORE_FLOOR = 10;

/** Number of top-scoring skills surfaced in the HINT note. */
const SKILL_TOP_N = 3;

/**
 * FLAT topK for the semantic wiki.get call. NOT derived from
 * listSkills().length: the 'skills' wiki domain is SHARED ACROSS PROJECTS
 * and accumulates rows from every project on the machine (the loader's
 * orphan sweep is own-scope only, so other projects' rows survive), so the
 * loaded-skill count is NOT an upper bound on the domain row count. Measured
 * on a 66-row domain, topK=50 yields 0 hidden results. Residual risk: if the
 * domain grows enough that 50 starts truncating, `results.length === topK`
 * (a saturated window) is the signal, logged below as a warning.
 */
const SKILL_SEMANTIC_TOPK = 50;

// ── Skill triologue status (folded from utils/skill-dedup.ts) ───────────
// Classifies a skill as new / suggested / loaded by scanning the triologue
// history. Used by injectSkillHint to partition the matched skills before
// surfacing them. The 3 helpers below are module-private; the classification
// itself is a private method on SkillSuggester.

/** A skill's relationship to the current triologue history. */
type SkillTriologueStatus = 'new' | 'suggested' | 'loaded';

/**
 * Type guard: check if a message is a tool response for a specific tool
 * name. Message extends OllamaMessage which doesn't have tool_name in its
 * type definition, but the Ollama API does return it on tool role messages.
 */
function isToolResponse(msg: Message, toolName: string): boolean {
  return msg.role === 'tool' && (msg as { tool_name?: string }).tool_name === toolName;
}

/** Check if a message content contains a [HINT] note (injected by triologue.note('HINT', ...)). */
function isHintNote(content: string): boolean {
  return /^\[hint\]/i.test(content.trim());
}

/** Check if a message content contains a skill_search result (skill names + descriptions). */
function isSkillSearchResult(content: string): boolean {
  return /Found \d+ skill\(s\) matching/i.test(content);
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

  // ── Scoring (positional points + semantic boost) ──────────────────────

  /**
   * Positional keyword points for one skill.
   *
   * For each significance-ordered query keyword `kw[i]` (i < 5), the skill
   * earns KEYWORD_WEIGHTS[i] points when it owns `kw[i]` as an exact
   * (case-insensitive) token. Weights are [10, 7, 5, 3, 2] for the
   * 1st..5th keyword; keywords beyond the 5th are IGNORED (so a long
   * extraction cannot inflate a score). Matching is exact-token membership,
   * NOT substring — `includes` would let "go" match "logging".
   *
   * Returns 0 when the skill owns none of the query keywords. That 0 is the
   * HARD precondition of the whole pipeline: `points > 0` gates entry, so a
   * skill surfaced on semantic similarity alone is impossible (0 × anything
   * = 0).
   *
   * Pure (no instance state) but lives on the class so SkillSuggester owns
   * the discovery pipeline as one cohesive unit. Mirrors skill_search.ts's
   * scoreboard so both consumers rank identically.
   *
   * @param skillKeywords - the skill's `keywords` frontmatter (any case).
   * @param keywords - the extraction's significance-ordered keywords
   *        (already lowercased by extractKeywords).
   */
  private keywordPoints(skillKeywords: string[], keywords: string[]): number {
    const kwSet = new Set(skillKeywords.map(k => k.toLowerCase()));
    let points = 0;
    for (let i = 0; i < keywords.length && i < KEYWORD_WEIGHTS.length; i++) {
      if (kwSet.has(keywords[i])) points += KEYWORD_WEIGHTS[i];
    }
    return points;
  }

  /**
   * Semantic boost factor for a skill's similarity.
   *
   *   boost = 1 + (similarity - getSkillMatchThreshold())
   *
   * The boost is NEUTRAL (1.0) at the configured similarity threshold and
   * rises linearly to 1.5 at perfect similarity (threshold 0.5 → 0.7 = 1.2,
   * 0.9 = 1.4). `ctx.wiki.get` already filters `similarity >= threshold`, so
   * a returned skill always has boost >= 1.0.
   *
   * This is a SOFT boost, not an intersection: a keyword-matched skill that
   * is absent from the semantic window is NOT excluded — the caller simply
   * skips the boost and uses 1.0, so the skill keeps its raw keyword points
   * (e.g. 12 × 1.0 = 12, which still clears the floor of 10).
   */
  private semanticBoost(similarity: number): number {
    return 1 + (similarity - getSkillMatchThreshold());
  }

  /**
   * Strip the "<scope>:" prefix from a wiki skill title to get the bare
   * skill name. Wiki titles use the format "<scope>:<skill-name>" (e.g.
   * "project:code-review"); a title without a colon is returned as-is.
   * Mirrors the logic in skill_search.ts.
   *
   * Used by {@link rankSkills} to map wiki.get result titles onto the bare
   * skill names that `listSkills()` carries, so the semantic boost can be
   * looked up per skill.
   */
  private baseSkillNameFromWikiTitle(title: string): string {
    return title.includes(':') ? title.split(':').slice(1).join(':') : title;
  }

  // ── HINT injection ────────────────────────────────────────────────────

  /**
   * Determine whether a skill is new, previously suggested, or already
   * loaded by scanning the triologue conversation history.
   *
   * Detection logic:
   *  - 'loaded': skill name appears in a skill_load tool call (arguments or
   *    result).
   *  - 'suggested': skill name/description appears in a HINT note or a
   *    skill_search result.
   *  - 'new': neither name nor description appears anywhere in the triologue.
   *
   * Iterates over all messages (M) for each skill. In practice N=1-5 and
   * M=20-100, so the cost is negligible compared to the LLM call that
   * follows. Early returns on the first 'loaded'/'suggested' match.
   *
   * Folded from the former standalone `src/utils/skill-dedup.ts`; now a
   * private method so SkillSuggester owns the full discovery pipeline.
   * Called by injectSkillHint to partition each matched skill before
   * surfacing it.
   */
  private getSkillTriologueStatus(triologue: Triologue, skill: Skill): SkillTriologueStatus {
    const messages = triologue.getMessagesRaw();
    const nameLower = skill.name.toLowerCase();
    const descLower = skill.description.toLowerCase();

    for (const msg of messages) {
      const content = msg.content || '';
      const contentLower = content.toLowerCase();

      // === Check for 'loaded' ===

      // 1a. skill_load tool result (role='tool', tool_name='skill_load')
      if (isToolResponse(msg, 'skill_load') && contentLower.includes(nameLower)) {
        return 'loaded';
      }

      // 1b. skill_load in assistant tool_calls
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.function.name === 'skill_load') {
            const argsStr = JSON.stringify(tc.function.arguments).toLowerCase();
            if (argsStr.includes(nameLower)) {
              return 'loaded';
            }
          }
        }
      }

      // === Check for 'suggested' ===

      // 2a. skill_search tool result — contains skill name/description
      if (isToolResponse(msg, 'skill_search') && contentLower.includes(nameLower)) {
        return 'suggested';
      }

      // 2b. [HINT] note mentioning the skill name
      if (isHintNote(content) && contentLower.includes(nameLower)) {
        return 'suggested';
      }

      // 2c. [HINT] note mentioning the skill description
      if (isHintNote(content) && descLower && contentLower.includes(descLower)) {
        return 'suggested';
      }

      // 2d. skill_search result content (detected by result pattern) mentioning the skill name
      if (isSkillSearchResult(content) && contentLower.includes(nameLower)) {
        return 'suggested';
      }
    }

    return 'new';
  }

  /**
   * Partition a list of skills into new/suggested/loaded (via
   * getSkillTriologueStatus) and inject a HINT note surfacing them.
   *
   * Shared by the ranking pipeline: called with the top-N scored skills
   * returned by {@link rankSkills}.
   *
   * New skills are listed with their description; suggested/loaded skills
   * are listed by name only. The note always ends with the skill_search
   * pointer and the silent-nudge discipline reminder.
   */
  private injectSkillHint(triologue: Triologue, skills: Skill[]): void {
    if (skills.length === 0) return;

    const newSkills: string[] = [];
    const suggestedSkills: string[] = [];
    const loadedSkills: string[] = [];

    for (const skill of skills) {
      const status = this.getSkillTriologueStatus(triologue, skill);
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

  // ── Ranking (points × boost → top N) ──────────────────────────────────

  /**
   * Score every loaded skill and return the top {@link SKILL_TOP_N}.
   *
   * Pipeline:
   *  1. Semantic window — ONE `ctx.wiki.get` on the free-form query, mapped
   *     to `bare skill name (lowercased) → highest similarity`. Graceful
   *     failure: a throw (no embedding model / transient) degrades to
   *     keyword-only ranking (every boost = 1.0) rather than staying silent.
   *  2. points = {@link keywordPoints} per skill; skills with `points === 0`
   *     are dropped (the hard precondition — no pure-semantic entry).
   *  3. score = points × boost, where boost is {@link semanticBoost} when the
   *     skill is in the semantic window and 1.0 otherwise.
   *  4. Keep only `score > SKILL_SCORE_FLOOR` (STRICT), sort desc, take
   *     SKILL_TOP_N. The sort is stable, so ties keep `listSkills()` order.
   *
   * `topK` is the flat SKILL_SEMANTIC_TOPK; when the wiki returns exactly
   * that many rows the window may be truncating (see the constant's doc), so
   * a verbose note is emitted as an operator signal.
   *
   * @param ctx - the AgentContext (reads `ctx.wiki.get` + `ctx.skill.listSkills()`).
   * @param keywords - the significance-ordered keywords from the extraction
   *        (may be empty — the caller guards before calling).
   * @param freeformQuery - the validated (non-empty) semantic phrase.
   * @returns the top-scoring skills (0..SKILL_TOP_N), highest score first.
   */
  private async rankSkills(
    ctx: MachineEnv['ctx'],
    keywords: string[],
    freeformQuery: string,
  ): Promise<Skill[]> {
    const threshold = getSkillMatchThreshold();

    // 1. Semantic window → bare-name → best similarity.
    const similarityByName = new Map<string, number>();
    try {
      const semResults = await ctx.wiki.get(freeformQuery, {
        domain: 'skills',
        topK: SKILL_SEMANTIC_TOPK,
        threshold,
      });
      // Saturated window: the domain may hold more qualifying rows than the
      // cap lets through — a signal to raise SKILL_SEMANTIC_TOPK.
      if (semResults.length === SKILL_SEMANTIC_TOPK) {
        ctx.core.verbose(
          'collect-skill',
          `semantic window saturated (topK=${SKILL_SEMANTIC_TOPK}); results may be truncated`,
        );
      }
      for (const r of semResults) {
        const baseName = this.baseSkillNameFromWikiTitle(r.document.title).toLowerCase();
        if (!baseName) continue;
        const prev = similarityByName.get(baseName);
        if (prev === undefined || r.similarity > prev) {
          similarityByName.set(baseName, r.similarity);
        }
      }
    } catch {
      // Semantic search unavailable → keyword-only ranking (boost 1.0).
    }

    // 2 + 3 + 4. Score, gate, order, truncate.
    return ctx.skill
      .listSkills()
      .map(skill => {
        const points = this.keywordPoints(skill.keywords, keywords);
        const similarity = similarityByName.get(skill.name.toLowerCase());
        const boost = similarity === undefined ? 1 : this.semanticBoost(similarity);
        return { skill, score: points * boost };
      })
      .filter(x => x.score > SKILL_SCORE_FLOOR)
      .sort((a, b) => b.score - a.score)
      .slice(0, SKILL_TOP_N)
      .map(x => x.skill);
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
   * Ranking (after a successful extraction yields keywords):
   *  - {@link rankSkills} scores every loaded skill (positional keyword
   *    points × semantic boost), keeps `score > SKILL_SCORE_FLOOR`, and
   *    returns the top SKILL_TOP_N for the HINT note.
   *
   * @param firstSteerNote - the freshest steering note drained this pass
   *        (from collectMailsAndInput), or null.
   *
   * Side effects on this singleton: `lastQuery` (query dedup cursor) and
   * `cooldown` — armed ONLY on a success/skipped outcome; a `failed`
   * outcome (ESC / transient) leaves query eligible for retry.
   */
  async suggestSkill(env: MachineEnv, turn: TurnVars, firstSteerNote: string | null): Promise<void> {
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

    // Extract significance-ordered keywords from the composite via LLM
    // (ESC-safe), using the SHARED extractor also used by the skill_search
    // tool so on-demand search and the proactive nudge rank identically.
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
    const result: KeywordExtractionResult = await ctx.core.escAware(
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

    // The semantic phase needs a valid freeformQuery. When it is missing,
    // FAIL FAST and leave the query eligible for a retry: clearThrottle
    // undoes the marking + cooldown-arming performed above so the next pass
    // re-attempts extraction (the LLM gets another chance to produce a valid
    // freeformQuery). This mirrors the `failed` path — both leave the query
    // eligible and the cooldown at 0.
    if (!freeformQuery || !freeformQuery.trim()) {
      this.clearThrottle();
      return;
    }

    // Score every loaded skill (positional points × semantic boost), keep
    // those above the floor, and surface the top N as a HINT note.
    const ranked = await this.rankSkills(ctx, keywords, freeformQuery);
    if (ranked.length === 0) return;

    this.injectSkillHint(triologue, ranked);
  }
}

/**
 * Process-wide singleton. Owns the discovery throttle state (query dedup
 * cursor + cooldown); the state machine calls `reset()` at each turn
 * boundary. Single source of truth for skill-discovery state.
 */
export const skillSuggester = new SkillSuggester();

/**
 * Begin a fresh session after an in-process conversation clear (/clear or
 * double-Ctrl+L). This is NOT a normal turn boundary: those clears run with
 * NO state transition (double-Ctrl+L is a raw callback; /clear returns
 * PROMPT from SLASH), so the state-machine turn-boundary guard — which both
 * (a) resets the suggester and (b) rebuilds TurnVars fresh — never runs.
 *
 * Resetting the suggester ALONE is a half-reset that leaves a regression:
 * `turn.lastUserQuery` (and the brief/hint sources) still hold the OLD turn's
 * values, while `SkillSuggester.lastQuery` is now ''. On the next COLLECT the
 * query source is the stale `lastUserQuery`, which differs from the empty
 * cursor, so `queryChanged` is true and extraction re-fires on context that
 * belongs to a conversation the user just cleared (the triologue itself is
 * empty). See PR #22 review (P1).
 *
 * The fix: treat a clear as a real turn boundary by invalidating the stale
 * turn fields as well as resetting the suggester, so the next COLLECT sees
 * an empty query source and skips extraction until a genuine new query
 * arrives (a fresh prompt resets them anyway via `turn.lastUserQuery = query`).
 *
 * The other TurnVars fields (nudges, todo cursor) are harmless to carry over —
 * a clear empties todos/issues, so the todo nudge simply re-arms on its own
 * cadence. Only the three "composite source" fields drive skill discovery and
 * must match the cleared conversation.
 *
 * @param turn - the live TurnVars instance to invalidate (same object the
 *        state machine holds, so the mutation is visible to the next COLLECT).
 */
export function beginFreshSession(turn: Pick<import('../state-machine.js').TurnVars, 'lastUserQuery' | 'lastBriefMessage' | 'lastHintFocus'>): void {
  skillSuggester.reset();
  turn.lastUserQuery = '';
  turn.lastBriefMessage = '';
  turn.lastHintFocus = '';
}