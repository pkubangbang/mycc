# Plan: Composite Keyword Extraction (X+Y+Z) in COLLECT

**Date:** 2026-09-16
**Status:** Reviewed — counterwork peer review completed (see Review Findings below)

## Goal

Improve the `extractedKeywords` → `suggestedSkills` pipeline by composing
keywords from three sources (X, Y, Z) and moving keyword extraction from the
PROMPT state to the COLLECT state.

| Source | Label | Meaning |
|---|---|---|
| X | last brief message | Agent's self-reported current focus |
| Y | last user query OR last steering note | User's current intent (the trigger) |
| Z | hint round `focus_on` | Recovery guidance from the last hint round |

## Background — Current Flow (BEFORE)

1. **PROMPT** (`src/loop/states/prompt.ts`, line ~455): `extractKeywords(userQuery)`
   → `turn.extractedKeywords`. Only the user query text is used.
2. **TOOL** (`src/loop/states/tool.ts`, lines ~156-182): if
   `turn.extractedKeywords` is empty and the brief tool was called,
   `extractKeywords(briefMessage)` → `turn.extractedKeywords` (fallback).
3. **COLLECT** (`src/loop/states/collect.ts`, step 6, lines ~570-620):
   consume `turn.extractedKeywords`, match against the skill list, inject a
   HINT note with suggested skills.

**Problem:** Only the user query (Y) feeds extraction. The brief message (X)
is a weak fallback that only fires when Y produced nothing. The hint round's
`focus_on` (Z) is never used. The autonomous null-input path (PROMPT returns
COLLECT without user input) gets zero skill discovery.

## New Flow (AFTER)

1. **PROMPT**: no extraction — just sets `turn.lastUserQuery` (already does
   this at line ~444).
2. **TOOL**: no extraction — stores `turn.lastBriefMessage` (new field, one
   line).
3. **COLLECT** (new step 5.5, before the old step 6): compose X+Y+Z text →
   if Y changed AND cooldown expired → `extractKeywords(compositeText)` →
   match against skills → inject HINT.

### Why move to COLLECT

All three sources converge in COLLECT:

- Steering notes are drained here (Y).
- The hint round fires here (Z).
- The brief message from the prior TOOL pass is on TurnVars (X).

The autonomous null-input path gets skill discovery for free because COLLECT
runs on every pipeline pass regardless of input source.

## Throttle Design

**Trigger:** Only Y changes (new user query or new steering note). X and Z
enrich the composite but never trigger extraction by themselves.

**Rationale:**

- A brief message (X) fires frequently during work — triggering skill
  discovery on every brief would be noisy.
- A hint round (Z) fires during confusion recovery — not a "new task"
  signal.
- Only user content (Y) represents a genuine context shift where new skills
  might be relevant.

**Cooldown:** After extraction fires, suppress for **3** COLLECT passes even
if Y changes again. Prevents rapid re-triggering from consecutive user
messages.

**Composite text construction:**

```typescript
const parts: string[] = [];
// X — last brief message (agent's self-reported focus)
if (turn.lastBriefMessage) parts.push(turn.lastBriefMessage);
// Y — last user query OR steering note (the trigger source)
//     Steering note takes precedence (freshest mid-task direction)
if (firstSteerNote) {
  parts.push(firstSteerNote);
} else if (turn.lastUserQuery) {
  parts.push(turn.lastUserQuery);
}
// Z — last hint round focus_on (recovery guidance)
if (turn.lastHintFocus) parts.push(turn.lastHintFocus);
const compositeText = parts.join('\n');
```

**Trigger + cooldown check:**

```typescript
// Decrement cooldown each pass
if (turn.skillDiscoveryCooldown > 0) turn.skillDiscoveryCooldown--;

// Only extract when Y changed AND cooldown expired
const yChanged = (firstSteerNote !== null && firstSteerNote !== turn.lastSkillY)
  || (firstSteerNote === null && turn.lastUserQuery !== '' && turn.lastUserQuery !== turn.lastSkillY);

if (yChanged && turn.skillDiscoveryCooldown === 0 && compositeText.trim().length >= 4) {
  const keywords = await ctx.core.escAware(
    async (ac) => extractKeywords(compositeText, ac.signal),
    () => [] as string[],
  );
  // Mark BOTH the trigger source AND the fallback source as "seen" so
  // neither re-triggers spuriously. Without marking the fallback
  // (lastUserQuery) when a steering note was the trigger, the consumed
  // steering note would disappear on the next pass and the unchanged
  // lastUserQuery would re-trigger after cooldown expires.
  // (Review finding BUG 1 — spurious double-trigger.)
  turn.lastSkillY = firstSteerNote ?? turn.lastUserQuery;
  if (firstSteerNote && turn.lastUserQuery) {
    turn.lastSkillY = turn.lastUserQuery; // also mark the fallback as seen
  }
  turn.skillDiscoveryCooldown = 3;
  // ... match keywords against skills (current step 6 logic), inject HINT
}
```

The `>= 4` guard matches the existing trivial-query skip in
`keyword-extractor.ts` (line 48) — avoids an LLM call for empty or
single-char composites.

## Data-Availability Gaps

### X — Last Brief Message (new `TurnVars.lastBriefMessage`)

The brief message is only available at tool execution time. Currently it is
extracted synchronously in `tool.ts` and never persisted. Fix:

- **TOOL state** (`tool.ts`, inside the existing `if (toolName === 'brief')`
  block, after the `turn.nextBriefNudge = 5` reset): add one line
  `turn.lastBriefMessage = briefMessage;`. The `briefMessage` variable is
  already parsed. The extraction block (lines ~156-182) is removed; the
  storage line replaces it.
- **TurnVars** (`state-machine.ts`): add `lastBriefMessage: string`,
  initialized to `''` at both TurnVars construction sites (lines 188 and
  206).
- **Scope:** Turn-scoped — resets to `''` at each PROMPT/AWAIT boundary.

### Z — Hint Round `focus_on` (expose from HintRoundManager)

`HintRoundManager.generate()` currently returns `'aborted' | 'success' |
'compact'` — the parsed `HintData` (including `focus_on`) is private and
discarded after formatting the HINT note. Fix:

1. **`hint-round.ts`** — change the return type of `generate()` and
   `retryLoop()` to:
   ```typescript
   'aborted' | 'compact' | { status: 'success'; focusOn: string }
   ```
   On the `'success'` path in `retryLoop()` (after
   `this.deps.note('HINT', ...)`), return `{ status: 'success', focusOn:
   hintData.focus_on }` instead of `'success'`. The `'aborted'` and
   `'compact'` paths return as before. The caller in `generate()`
   propagates this through the retry loop unchanged (it only checks `!==
   'retry'`).

2. **`collect.ts`** — in the hint round block (line ~310), after a
   successful result:
   ```typescript
   if (result !== 'aborted' && result !== 'compact') {
     turn.lastHintFocus = result.focusOn;
   }
   ```
   Add `lastHintFocus: string` to TurnVars, initialized to `''`.

3. **`triologue.ts`** — update `generateHintRound()` return type annotation
   (pass-through, line ~452). No logic change.

## Files to Change

| # | File | Action | Details |
|---|---|---|---|
| 1 | `src/loop/state-machine.ts` | EDIT | TurnVars: remove `extractedKeywords`, add `lastBriefMessage: string`, `lastHintFocus: string`, `lastSkillY: string`, `skillDiscoveryCooldown: number`. Initialize at both construction sites (lines 188 and 206). |
| 2 | `src/loop/states/prompt.ts` | EDIT | Remove `extractKeywords` import (line ~31). Remove extraction block (lines ~453-462): the `turn.extractedKeywords = await escAware(...)` call and the `isDebuggingPrompt()` debug print. |
| 3 | `src/loop/states/tool.ts` | EDIT | Remove `extractKeywords` import (line ~27). In `if (toolName === 'brief')` block: remove the extraction sub-block (lines ~156-182), replace with `turn.lastBriefMessage = briefMessage;`. Keep `turn.nextBriefNudge = 5`. |
| 4 | `src/loop/triologue/hint-round.ts` | EDIT | Return type: `'aborted' \| 'compact' \| { status: 'success'; focusOn: string }`. Success path returns focusOn. |
| 5 | `src/loop/triologue.ts` | EDIT | Update `generateHintRound()` return type annotation (pass-through). |
| 6 | `src/loop/states/collect.ts` | EDIT | Import `extractKeywords`. Capture `focusOn` from hint round success. Replace step 6 with composite X+Y+Z extraction + cooldown + matching + HINT injection. Remove `turn.extractedKeywords` consumption. |

**No new files in `src/`.** No config changes. `keyword-extractor.ts` is
unchanged.

## Edge Cases

1. **First COLLECT pass of a turn (auto mode, no user input):**
   `lastUserQuery` is `''`, no steering note, no brief yet, no hint round.
   Composite text is empty → the `>= 4` guard skips extraction. No LLM call,
   no HINT. Correct — nothing to discover yet.

2. **Steering note drained this pass (Y = firstSteerNote):** Triggers
   extraction even if `lastUserQuery` is empty (auto mode with webui
   steering). `turn.lastSkillY` is set to `firstSteerNote` to prevent
   re-triggering on the next pass.

3. **Hint round fires this pass (Z captured):** `turn.lastHintFocus` is set
   in step 3. If Y also changed, the composite includes Z. If Y did not
   change, no extraction fires — but Z is persisted for the next Y-change
   trigger.

4. **Multiple briefs in one turn:** Each brief overwrites
   `turn.lastBriefMessage`. Only the latest brief enriches the composite.
   Correct — the latest brief reflects the agent's most recent
   self-assessment.

5. **Compact mid-turn (hint round signals compact):** The compact path
   resets confusion, sequence, hooks. TurnVars are NOT reset (persist
   across COLLECT→COLLECT mid-turn). `lastHintFocus` is NOT updated on the
   compact path (the hint round returned `'compact'`, not success). The
   stale value from a previous hint round persists. Acceptable: after
   compaction, the next Y-change uses whatever Z is available.

6. **ESC during extraction:** `escAware` returns `[]` on interrupt. The
   cooldown is NOT set (extraction did not complete). `lastSkillY` is NOT
   updated. Next pass retries if Y is still "changed". Mirrors current
   behavior in `prompt.ts`.

## Testing

| # | Test file | What it covers |
|---|---|---|
| 1 | `src/tests/loop/states/collect-keyword-discovery.test.ts` (NEW) | Composite text construction, Y-change detection, cooldown decrementation, skip-when-empty, steering-note-priority-over-userQuery, HINT injection on match, no-HINT on no-match, **steering-note-then-no-steering-note multi-pass spurious double-trigger** (Review BUG 1) |
| 2 | `src/tests/loop/triologue/hint-round-focus.test.ts` (NEW) | `generate()` returns `{ status: 'success', focusOn: '...' }` on success, `'aborted'` on ESC, `'compact'` on should_compact |
| 3 | `src/tests/state-machine/state-machine.test.ts` (EDIT, lines 253 & 465) | Replace `extractedKeywords` assertions with the 4 new fields |
| 4 | `src/tests/loop/esc-test-helpers.ts` (EDIT, line 34) | Replace `extractedKeywords: []` with the 4 new field initializers in the TurnVars mock |

## Design Review Notes

### Scope

- `extractKeywords()` (keyword-extractor.ts) is unchanged — it already
  handles multi-language input and returns 2-5 English keywords. The change
  is purely *what text* we feed it and *where* we call it.
- 6 source files, all small targeted edits. The largest change is
  collect.ts where step 6 is replaced — but the matching/HINT-injection
  logic is reused verbatim, just moved inside the new conditional.
- No new files in `src/`, no new abstractions.

### Correlation

- The `hint-round.ts` return type change ripples to `triologue.ts` (facade
  type) and `collect.ts` (caller). All three must change together — a
  partial change causes a type error.
- The TurnVars field changes ripple to `state-machine.ts` (definition + 2
  init sites), `prompt.ts` (removes a write), `tool.ts` (removes a write,
  adds a new write), and `collect.ts` (removes a read, adds new reads).
- No ordering constraint between the hint-round and TurnVars changes — they
  are independent axes that converge in `collect.ts`.
- `turn.extractedKeywords` as a cross-state shuttle becomes unnecessary —
  keywords are produced and consumed in the same COLLECT function. The field
  and its consume-clear pattern are removed entirely.

## Review Findings (Counterwork Peer Review)

**Method:** Counterwork/Debate pattern. deepseek-reviewer (skeptical stance)
terminated due to repeated LLM watchdog timeouts. glm-reviewer delivered
both constructive (round 1) and skeptical (round 2) positions, verified
all claims against the 6 source files.

### Verdict: Plan is sound

All 5 constructive gaps proposed in round 1 were withdrawn under skeptical
scrutiny in round 2:

1. **Brief accumulation** → adds noise, latest-only is correct.
2. **Compact-path focus_on** → stale after compaction wipes context; the
   plan's design (don't capture on compact path) is correct.
3. **Composite text order (Y+X+Z)** → LLM keyword extraction isn't
   sequential reading; order has negligible effect.
4. **Cooldown re-arm only on match** → would allow re-extraction of
   unchanged composites on every Y-change, wasting LLM calls.
5. **wiki_query opportunity** → scope creep; conflates skill matching with
   knowledge retrieval.

### BUG 1 (found & fixed): Spurious double-trigger after steering note exhaustion

When a steering note triggers extraction, `lastSkillY` is set to the
steering note text. On subsequent passes the steering note is consumed
(`firstSteerNote = null`), so `yChanged` falls back to checking
`lastUserQuery` — which was set before the steering note arrived and
differs from `lastSkillY`. After the 3-pass cooldown expires, extraction
fires again on the same stale user query.

**Fix:** After extraction, mark BOTH the trigger source AND the fallback
source as "seen" (see the updated trigger + cooldown check above). This
prevents the fallback `lastUserQuery` from re-triggering after a steering
note is consumed.

### Verified claims

- The return type change is fully accounted for — all callers traced
  (`generate()` retry loop checks `!== 'retry'`, `collect.ts` string
  comparisons for `'aborted'`/`'compact'` still work, `triologue.ts`
  pass-through).
- TurnVars reset boundaries are correct at both construction sites
  (state-machine.ts lines 188 and 206).
- No missed downstream consumers of `extractedKeywords`.

### Test amendment

Added a test case for the steering-note-then-no-steering-note multi-pass
spurious double-trigger scenario to the new
`collect-keyword-discovery.test.ts`.