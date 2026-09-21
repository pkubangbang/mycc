# Adaptive Skill-Match Thresholds (α/β) for the COLLECT Skill Suggestor

**Date:** 2026-09-21
**Status:** Design — peer-reviewed (remote peer `e894b236…`); fixes folded in
**Companion to:** [`plan-composite-keyword-extraction.md`](./plan-composite-keyword-extraction.md) (the brief+query+hint composite that feeds this filter)

## Goal

Replace the coarse `Z > 0` substring match in the COLLECT step-6 skill
suggestor with an **adaptive, statistically-grounded filter** whose thresholds
are derived from the actual keyword-space geometry (`X`, `W`, `Y`), not
hardcoded constants. The objective: cut the false-positive nudges (noisy
"HINT: New relevant skills…" notes) without suppressing true-skill discovery.

## Background — the current filter and why it is noisy

In `src/loop/states/collect-skill.ts`, `SkillSuggester.runKeywordExtraction`
matches the LLM-extracted query keywords (`Y`, 2–5 words from
`keyword-extractor.ts`) against each loaded skill's keyword list (`X`) and
name. The match predicate is:

```ts
const matched = allSkills.filter(s => {
  const nameLower = s.name.toLowerCase();
  const kwLower = s.keywords.map(k => k.toLowerCase());
  return keywords.some(kw =>
    nameLower.includes(kw) ||
    kwLower.some(k => k.includes(kw) || kw.includes(k)),
  );
});
```

Three structural defects make this noisy:

1. **Substring asymmetry.** `k.includes(kw) || kw.includes(k)` lets a 2-char
   query keyword (`"go"`, `"c"`) match any skill keyword containing those
   letters (`"logging"`, `"docker"`, `"config"`). A short keyword is a
   near-universal substring.
2. **No proportionality.** `Z > 0` treats `Z = 1` out of `Y = 5` the same as
   `Z = 4` out of `Y = 5`. A skill sharing one incidental keyword ranks equal
   to one sharing four.
3. **No skill-side weighting.** A skill with 30 keywords is ~30× more likely
   to include some query keyword than a skill with 3, yet both pass the same
   `Z > 0` bar. Big vocabularies self-promote.

The noise is not "the threshold is too low" — it is that `Z > 0` is the wrong
statistic. It counts **presence** when we want **agreement**.

## The model — keyword overlap as sampling without replacement

Treat the keyword match as a random-subset event under a **null hypothesis of
irrelevance** (the skill is *not* relevant; any overlap is accidental). The
query picks `Y` of the `W` universe keywords; the skill owns `X` of them.
Under the null:

- **Expected overlap:** `E[Z | null] = X · Y / W`
- **Variance (hypergeometric, sampling without replacement):**
  `Var = Y · (X/W) · ((W − X)/W) · ((W − Y)/(W − 1))`
- **Standard deviation:** `σ = sqrt(Var)`

A match counts as "real" when `Z` exceeds what irrelevance would produce —
i.e. above the null mean by `κ` standard deviations:

```
Z_min = E[Z | null] + κ · σ = (X · Y / W) + κ · sqrt(Var)
```

`κ` is the **only** knob (default `κ = 2`, "2σ above random"). Everything
else falls out of `X`, `W`, `Y`.

> **Peer-review note (uniform-sampling assumption).** The hypergeometric null
> assumes `Y` is drawn uniformly from `W`. The peer confirmed this is
> **conservative in the right direction** (it overestimates accidental overlap
> → gates are stricter than needed → safe for a nudge system where false
> negatives are cheap), but flagged that uniform sampling **underestimates**
> accidental overlap on Zipfian hot words (`intent`, `bash`, `skill`) —
> precisely the `"go" → logging/docker` substring bug. A more accurate null
> weights each probe keyword by its document frequency:
> `E[Z | null] = Σ_{k ∈ probe} df(k) / W`. This is a **future refinement**;
> the uniform null ships first because (a) it is conservative, (b) `df`
> requires a corpus scan not yet wired, and (c) **if the null is df-weighted,
> both `β` and `Z_min` MUST recompute from the same `E`** or the precision and
> recall gates disagree (see caveat "gate baseline match").

### Where the variables come from

| Symbol | Meaning | Source in code |
|---|---|---|
| `W` | total skill keyword universe (deduped) | `loader.getSkillKeywords().length` |
| `X` | per-skill keyword count | `s.keywords.length` |
| `Y` | query keyword count (2–5, LLM-extracted) | `keywords.length` |
| `Z` | exact-token intersection of query ∩ skill keywords | computed (was only a boolean `some()`) |

`W` is already computed in the COLLECT pipeline — it is the
`availableKeywords` passed to `extractKeywords`. `X` and `Y` are trivially
available per-skill and per-pass.

## The two derived thresholds

Both gates are **derived from `X, W, Y`**, not hardcoded. Both must pass
(logical AND).

### β — precision gate (skill-side, anti-vocabulary-bloat)

Statistic: `Z / X` (what fraction of the skill's own vocabulary the query
hits). Raw threshold:

```
β_raw = κ · Y / W
```

A skill is interesting when its hit-density exceeds the **background density**
`Y/W` (the chance any given skill-keyword is hit by a random query) by factor
`κ`.

> **Peer-review fix (β clamp — the most serious flaw found).** Unclamped
> `β = κ·Y/W` is broken at **both** ends of `W`:
> - **Small `W`:** at `W = 4, Y = 7`, `β_raw = 3.5 > 1` → `Z/X ≥ 3.5` is
>   **unsatisfiable** → the keyword path silently dies and everything is
>   forced to Branch B. (Verified: mdcalc `β_raw = 3.5`.)
> - **Huge `W`:** at `W = 1000, Y = 5`, `β_raw = 0.01` → vanishes → the
>   vocabulary-bloat self-promotion bug the gate was meant to fix **returns**.
>   (Verified: mdcalc `β_raw = 0.01`.)
>
> Fix: clamp `β` into a fixed band:
> ```
> β = clamp(β_raw, β_min, β_cap)   with β_min = 0.05, β_cap = 0.5
> ```
> - `β_min = 0.05` — even at huge `W`, a skill must cover ≥5% of its vocab to
>   pass (kills the bloat return).
> - `β_cap = 0.5` — even at tiny `W`, the gate never demands >50% coverage
>   (keeps the keyword path alive instead of hard-disabling it).
>
> Verified: at `W=4,Y=7` β clamps `3.5 → 0.5`; at `W=1000,Y=5` β clamps
> `0.01 → 0.05`.

### α — recall gate (query-side)

Statistic: `Z / Y` (what fraction of the query the skill covers). Threshold:

```
α = min( Z_min / Y , 1 )  where  Z_min = (X·Y/W) + κ·σ
   = min( X/W + (κ/Y)·σ , 1 )
```

The first term `X/W` is the skill's **coverage** of the universe — a skill
owning a bigger slice of `W` is held to a higher `Z`. The second term
`(κ/Y)·σ` is the noise margin. Capped at `1` so a float artifact never
demands `Z > Y`.

> **Peer-review fix (explicit ineligible rule, not a buried divide).** An
> uncapped `α > 1` (e.g. `1.06` for `X=20, W=40`) is an **implicit hidden
> hard-disable** of the keyword path — a math artifact turned into an
> undeclared policy. The peer's rule: **state the policy explicitly.**
> Alongside the `min(…, 1)` cap, add a *named* eligibility rule:
> ```
> if X / W > ρ  (default ρ = 0.5)  →  skill is keyword-path-ineligible
>                                       →  defer to Branch B (semantic)
> ```
> A skill that owns more than half the keyword universe is too broad to be
> matched by keyword overlap at all — its `Z` is uninformative — so it is
> routed to the semantic intersection path. This replaces "α silently goes
> >1 and the gate becomes unreachable" with a readable, debuggable rule.
> `ρ = 0.5` is the default; it is a second named knob alongside `κ`.

### The `Z > 0` floor and the crash guards (peer-review)

Before the ratio tests, three guards run in order — the first two are
**crash guards** the peer identified by reproducing the variance formula at
degenerate inputs:

```ts
if (Z === 0) return false;          // floor: rejects X=0 keywordless skills
if (X === 0 || W === 0) return false; // degenerate universe
if (W <= 1) return Z > 0;           // (1a) W≤1 -> (W-Y)/(W-1) divides by zero
                                    //      -> no null model; fall back to Z>0 floor
if (Y > W) Y = Math.min(Y, W);      // (1b) Y>W -> negative variance -> sqrt(NaN)
                                    //      dedup+clamp Y (probe can't sample more
                                    //      than the universe holds)
```

**Verified crashes (mdcalc):**
- `W = 1, Y = 2` → the variance term `(W−Y)/(W−1) = (1−2)/0` is **divide-by-zero**
  → `σ = NaN`. Guard (1a) fires: no null model, fall back to the `Z > 0`
  floor (the original behavior — safe, just unrefined).
- `Y = 7, W = 4` → the variance term `(W−Y)/(W−1) = −3/3 = −1` is **negative**
  → `sqrt(−1) = NaN`. Guard (1b) clamps `Y ← min(Y, W) = 4` so the variance is
  computed over a valid sample size.

Keywordless skills (`X = 0`) hit the `X === 0` guard and are matched by
**Branch B** (the existing semantic `wiki.get` intersection), not the keyword
path.

## Verified numbers (deterministic, mdcalc)

### Scenario matrix — `κ = 2`

| scenario | X | W | Y | E[Z] | σ | **Z_min** | **α** | **β** | β·X (Z floor) |
|---|---|---|---|---|---|---|---|---|---|
| small-W small-X | 4 | 40 | 3 | 0.30 | 0.51 | 1.31 | 0.44 | 0.15 | 0.60 |
| small-W **big-X** | 20 | 40 | 3 | 1.50 | 0.84 | **3.19** | 1.06 | 0.15 | 3.00 |
| big-W small-X | 4 | 200 | 3 | 0.06 | 0.24 | 0.54 | 0.18 | 0.03 | 0.12 |
| big-W big-X | 20 | 200 | 3 | 0.30 | 0.52 | 1.33 | 0.44 | 0.03 | 0.60 |
| big-W small-X, Y=2 | 4 | 200 | 2 | 0.04 | 0.20 | 0.43 | 0.22 | 0.02 | 0.08 |
| big-W small-X, Y=5 | 4 | 200 | 5 | 0.10 | 0.31 | 0.72 | 0.14 | 0.05 | 0.20 |
| **huge-W** small-X | 5 | 1000 | 5 | 0.025 | 0.16 | 0.34 | 0.07 | 0.01 | 0.05 |
| edge **X=0** | 0 | 200 | 5 | 0 | 0 | 0 | 0 | 0.05 | 0 |

### What the numbers confirm

1. **β auto-scales with `W`** — 0.15 (small W) → 0.03 (big W) → 0.01 (huge W).
   No re-tuning when the skill corpus grows.
2. **Big-`X` skills are held to higher `Z_min`** — row 2 (X=20) needs `Z ≥
   3.19` vs row 4 (X=4) needs `Z ≥ 0.54` at the same W=40. The 30-keyword
   vocab-bloat skill that passed on `Z = 1` is now rejected. Anti-bloat,
   derived not hardcoded.
3. **α stays in a sane 0.07–0.44 band** across all realistic scenarios —
   never demands `Z > Y`, never collapses to ~0. A fixed `α = 0.34` (an
   earlier hardcoded guess) would be too strict for huge-W and too lax for
   small-W/big-X; the derived `α` adapts.
4. **The `X = 0` edge is clean** — `E[Z]=σ=Z_min=α=0`, `β·X=0`; the `Z > 0`
   floor is what actually rejects it.
5. **α can exceed 1.0** (row 2: 1.06) — *correct*: it means "no achievable
   `Z` clears this skill under irrelevance at `κ=2`", i.e. a big-`X` skill in
   a small universe must show `Z ≥ 3.19` out of max 3 → unreachable by
   accident. The `min(…, 1)` cap is a float-safety guard, not a bug fix.
   (Post-review: this row also triggers the explicit `X/W = 0.5 > ρ`
   ineligible rule → Branch B, so the cap and the named rule agree.)

### Crash-guard verification (peer-review, mdcalc)

| case | W | Y | `(W−Y)/(W−1)` | raw β | **clamped β** | outcome |
|---|---|---|---|---|---|---|
| W=1, Y=2 (crash 1a) | 1 | 2 | **DIV0** | 4.0 | **0.5** | guard fires → `Z>0` floor |
| Y=7 > W=4 (crash 1b) | 4 | 7 | **−1** (neg var) | 3.5 | **0.5** | `Y←min(Y,W)=4` then recompute |
| β vanishes (huge W) | 1000 | 5 | 0.996 | 0.01 | **0.05** | clamp restores anti-bloat |

These three rows are the peer's fixes (1a) `W≤1`, (1b) `Y>W`, and (3) β
clamp, each verified to crash or misbehave without the guard and to behave
with it.

## The `Y` lever — precision vs recall

Sweeping `Y` from 2 to 5 at fixed `X=4, W=200, κ=2`:

| Y | E[Z] | σ | **Z_min** | **β** |
|---|---|---|---|---|
| 2 | 0.04 | 0.197 | 0.435 | 0.02 |
| 3 | 0.06 | 0.241 | 0.543 | 0.03 |
| 4 | 0.08 | 0.278 | 0.636 | 0.04 |
| 5 | 0.10 | 0.310 | 0.720 | 0.05 |

**Raising `Y` tightens both gates → precision ↑, noise-recall ↓.** This is
the *opposite* of the naive "more keywords → more matches" intuition. Trace:

- **β = κ·Y/W** grows with `Y` → higher hit-density demanded → precision ↑.
- **`Z_min`** grows with `Y` (both the `E[Z]` linear term and the `κ·σ`
  sqrt term rise). For a *relevant* skill whose `Z` scales ~linearly with `Y`
  at slope ~1, the rising floor stays passable; for an *irrelevant* skill
  whose `Z` only grows at the null slope `X/W`, the gap widens → noise
  recall ↓. True-skill recall is preserved.

So the `extract_keywords` prompt's "2–5 keywords" range is a **precision/recall
dial**, not just formatting:
- Bias toward `Y = 5` → stricter gates → fewer, higher-confidence hints
  (good for large `W`, false-positive-averse users).
- Bias toward `Y = 2` → looser gates → more hints, more noise (good for
  small `W`, over-suggest-rather-than-miss users).

## The implementation (drop-in replacement for the `matched` block)

```ts
/**
 * Significance knob: "κσ above the random-overlap null". κ=2 is a standard
 * 2-sigma bar — conservative for a nudge system (false negatives = no hint
 * that turn; false positives = noise). Lower to 1.5 to loosen.
 */
const SKILL_MATCH_KAPPA = 2;
/**
 * Coverage-eligibility threshold: a skill owning > ρ of the keyword universe
 * is too broad for keyword overlap to be informative -> defer to Branch B.
 * Replaces the "α silently >1" hidden hard-disable with a named rule.
 */
const SKILL_COVERAGE_RHO = 0.5;
/** β clamp band: prevents the precision gate from being unsatisfiable at
 * small W (β_raw>1) or vanishing at huge W (β_raw→0, bloat returns). */
const SKILL_BETA_MIN = 0.05;
const SKILL_BETA_CAP = 0.5;

const universe = loader.getSkillKeywords();
const W = universe.length;
// Dedup the probe so Y never exceeds the distinct-keyword universe (guard 1b).
const Y = Math.min(keywords.length, W);

const matched = allSkills.filter(s => {
  // Exact-token intersection (case-insensitive, NO substring includes).
  const kwSet = new Set(s.keywords.map(k => k.toLowerCase()));
  const Z = keywords.filter(kw => kwSet.has(kw)).length;
  if (Z === 0) return false;                   // floor: rejects X=0 keywordless skills

  const X = s.keywords.length;
  if (X === 0) return false;                    // keywordless -> Branch B
  // (1a) W≤1: no null model (variance term divides by zero) -> Z>0 floor.
  if (W <= 1) return true;
  // Named ineligible rule: a skill owning >ρ of the universe is too broad
  // for keyword overlap -> defer to Branch B. (Replaces buried α>1.)
  if (X / W > SKILL_COVERAGE_RHO) return false;

  // Derived thresholds from the hypergeometric null (Y already clamped ≤ W).
  const EZ = (X * Y) / W;
  const variance = Y * (X / W) * ((W - X) / W) * ((W - Y) / (W - 1));
  const sigma = Math.sqrt(Math.max(variance, 0));
  const Zmin = EZ + SKILL_MATCH_KAPPA * sigma;
  // Z is integer -> gate on ceil(Z_min), not the continuous Z_min.
  const recallOk = Z >= Math.ceil(Zmin);
  const betaRaw = (SKILL_MATCH_KAPPA * Y) / W;
  const beta = Math.min(Math.max(betaRaw, SKILL_BETA_MIN), SKILL_BETA_CAP);
  const precisionOk = (Z / X) >= beta;

  return recallOk && precisionOk;
});
```

`W` and `Y` are computed **once per pass** (before the `allSkills.filter`),
not per skill. `W` reuses the already-available `loader.getSkillKeywords()`.

### Peer-review fixes reflected in this code (vs the first draft)

1. **β clamp** `clamp(κ·Y/W, 0.05, 0.5)` — fixes unsatisfiable-at-small-W and
   vanishing-at-huge-W.
2. **Explicit `X/W > ρ` ineligible rule** — replaces the hidden `α > 1`
   hard-disable; broad skills defer to Branch B by a named, debuggable rule.
3. **Crash guards** — `W ≤ 1` → `Z > 0` floor (no null model); `Y > W` →
   `Y = min(Y, W)` (no negative variance).
4. **`ceil(Z_min)`** — `Z` is integer; gating on the continuous `Z_min` would
   let `Z = 0.72` "pass" a `Z_min = 0.72` bar by float rounding. `ceil` makes
   the floor `≥ 1` whenever `Z_min > 0`, matching the integer reality.
5. **Gate baseline match** — both `β` and `Z_min` derive from the *same* `E[Z]
   = X·Y/W` (the uniform null). If the null is later df-weighted, BOTH must
   recompute from the df-weighted `E` or the gates disagree.

### What changes in observable behavior (BEFORE / AFTER)

| Case | BEFORE (`Z>0`, substring) | AFTER (token + α/β) |
|---|---|---|
| query `["go","web","server"]`, skill kw `["logging","config","docker"]` | **matched** (`go`⊂`logging`) | rejected (Z=0 exact) |
| query 5 kw, skill matches 1 of its 30 | matched (Z>0) | rejected (precision 0.03 < β) |
| query 5 kw, skill matches 1 of its 4 | matched | matched (recall 0.2 ≥ α, precision 0.25 ≥ β) |
| query 2 kw, skill matches 1 of 3 | matched | matched (recall 0.5 ≥ α, precision 0.33 ≥ β) |
| query 5 kw, 6 skills each match ≥2 | Branch B (oversize) → semantic refine | same — and now the 6 are *real* matches, so the intersection is meaningful |

Branch B (the existing `wiki.get` semantic intersection for `matched.length
>= SKILL_OVERSIZE_THRESHOLD`) is **unchanged** — it remains the safety net for
genuine ambiguity. With the stricter Branch A filter, Branch B triggers less
often and on truly-ambiguous cases rather than substring garbage.

## Tuning guidance

- **`κ`** is the only knob. `κ = 2` (2σ) is the default. If real skills get
  suppressed, lower to `κ = 1.5` *before* loosening the formulas — `κ` is the
  designed escape hatch.
- **`β` calibration check:** `β·X` is the absolute `Z` floor the precision
  gate imposes on a given skill. Inspect `Math.max(…allSkills.map(s =>
  s.keywords.length))` — if the largest-`X` skill needs `≥ 2` hits at `κ=2`,
  the gate is working as intended; if it needs `≥ 3` and you're losing real
  matches, lower `κ`.
- **`Y` bias:** the `extract_keywords` prompt can be nudged from "2–5
  keywords" to "3–5" for a precision-favoring default. This compounds with
  the `β` tightening.

## Caveats and open questions

1. **Uniform-sampling assumption.** The hypergeometric null assumes `Y` is
   drawn uniformly from `W`. The peer review confirmed it is **conservative
   in the right direction** (overestimates accidental overlap → stricter
   gates → safe for a nudge system), but flagged that it *underestimates*
   accidental overlap on Zipfian hot words (`intent`, `bash`, `skill`) — the
   substring bug's root cause. A df-weighted null
   `E[Z|null] = Σ_{k∈probe} df(k)/W` is the future refinement; it ships
   later because `df` needs a corpus scan not yet wired, and **both gates
   must recompute from the same df-weighted `E`** when it lands. The
   *direction* (Y↑ → precision↑) is robust under either null; the *magnitude*
   is an upper bound, not yet measured against live traffic.
2. **`SKILL_MATCH_THRESHOLD` (Branch B).** Branch B's `ctx.wiki.get(..., {
   threshold: getSkillMatchThreshold() })` applies an embedding-similarity
   threshold (README default 0.5). Tightening Branch A makes Branch B's
   `threshold` the dominant noise gate for the oversize case — worth
   re-checking that default in the same pass, otherwise Branch A is fixed
   and Branch B's noise is untouched.
3. **Peer review (resolved).** Remote peer `e894b236…` reproduced the mdcalc
   numbers and returned four findings, all folded in:
   (a) null is reasonable & conservative — df-weighting noted as future work;
   (b) `κ=2` is the right default (collapses to "≥1" floor in the sparse
   regime, which is fine; `κ=1.5` is the documented relaxation);
   (c) **β auto-scaling was the most serious flaw** — unsatisfiable at small
   `W`, vanishing at huge `W` → fixed by the `[0.05, 0.5]` clamp;
   (d) α capped at 1 **and** the explicit `X/W > ρ → Branch B` rule added so
   the hard-disable is a named policy, not a buried divide.
   Plus three crash guards (W≤1, Y>W, ceil(Z_min)) and the gate-baseline-match
   invariant. Implementation proceeds.

## Key files

| File | Role |
|---|---|
| `src/loop/states/collect-skill.ts` | the `matched` filter being replaced (Branch A) + Branch B |
| `src/loop/keyword-extractor.ts` | the `Y` (2–5) extraction contract; the prompt-level precision/recall lever |
| `src/context/shared/loader.ts` | `getSkillKeywords()` — the `W` source |
| `src/config.ts` | `getSkillMatchThreshold()` — Branch B's embedding threshold (caveat 2) |