# Crossroad Feature

> **Status:** Implemented in `src/loop/crossroad.ts`. Detection and the cut grid
> are delegated entirely to `@pkubangbang/crossroad-detector@0.2.1` (the trainer's
> own `build_segments`); mycc owns no turning-word heuristic, and its only
> segmentation work is the four consumer normalisations N1–N4 described below.
> Cooldown: see `docs/crossroad/crossroad-cooldown.md`.

## Overview

The "crossroad" feature intercepts LLM responses that turn mid-reply — the model
changes direction partway through ("However…", "Wait…", "但…"). When a turn is
detected it:

1. **Splits** the response into `prefix → cutpoint → remainder`
2. **Generates 3 alternative continuations** via `forkChat` (forward / backward /
   synthesize), each required to repeat the anchor sentence before pivoting
3. **Selects** the best continuation with a second `forkChat` call
4. **Merges** it in the HOOK state, discarding the original tool calls — the LLM
   regenerates them in the next COLLECT round

A `brief`-ONLY tool-call set is a precondition to SKIP crossroad. `brief` is a
mid-thought status update whose text naturally contains "However"/"But"/"Wait";
that is hedging while reasoning, not a direction reversal. Firing on it would
truncate the reasoning and inject an alien continuation. A NON-brief tool call
alongside a turn IS a committed action the model pivoted away from — crossroad
fires and discards all tool calls.

## The vocabulary (settle this before arguing about anything else)

The package's segmenter returns **segments** — the spans the classifier is fed.
There is **no separate "window" level.** Five levels, and `segment` is the
model's input unit:

```
token  ≪  word  ≪  chunk  ≪  segment  ≪  stream
```

| Term | What it is | Size |
|---|---|---|
| **token** | the tokeniser's unit — not a character | ~4 Latin chars / ~1.5 CJK chars |
| **word** | a linguistic word; what the detector returns as `word` | 1–12 chars |
| **chunk** | text between punctuation, **commas/colons/semicolons included** | 6–42 code points |
| **segment** | chunks glued together; **the model's input unit** | **224–448 code points** |
| **stream** | the whole reply | 10³–10⁴ code points |

### Segments overlap; cut positions must not

There is no structure between `segment` and `stream` — no additional layer, and
no name for one. What needs stating is a distinction of **usage**:

| the same segments, used for | property |
|---|---|
| **what the model scores** | **overlap** — 404–672 cp, by design |
| **where a cut may land** (`createSegmenter`) | **a partition** — exactly one unit at any offset |

Segments overlap because the classifier must be fed from more than one offset,
so a turn near a seam is still seen. Cut positions must be a partition because
at a given offset exactly one unit is being replaced. Measured on a
1132-code-point document the scorer's spans are
`0..404, 269..665, 539..935, 726..1132` — two spans claim the same text, so a
cut at 269 and a cut at 404 would both be "inside" two units at once. That is
precisely why the overlapping spans cannot be the cut positions.

Consequences, both stated wrongly here before:

- **A cut position may be much finer than 224 code points.** A 9-code-point
  `" However,"` is a valid cut position — it is simply never a unit the model
  scored. The error was never "9 cp is too short"; it was calling those
  positions "segments the model scores".
- **mycc consumes cut positions only.** It never composes the spans the scorer
  is fed from, and the package deliberately does not export them for that reason.

### `word` sits one level below the segment

The classifier answers "did the turn happen in *this* segment?"; the hint answers
"which connective, if any, is in it". So a `word` can say *which* segment turned,
never *where inside* the segment the turn is — that information does not exist at
this granularity. Guessing at it is where the decoy-connective problem comes from.


## How text becomes model input

```
stream
 │  ① PUNCTUATION SPLIT — SENT_SPLIT = /(?<=[.!?,;:\n。！？，；：])/
 │     commas / colons / semicolons ARE boundaries.  Output: chunks.
 ▼
chunks          e.g. " However," — 9 code points
 │  ② GLUE — adjacent chunks merge until the span reaches SEG_MAX = 224.
 │     A single chunk longer than 224 is TILED at exactly 224: the only
 │     source of a boundary that does not follow punctuation.
 ▼
segments        224–448 code points, OVERLAPPING (suffix grows to 672,
                prefix shrinks below 448) so a turn near a seam is still
                seen.
                ← the model's input unit (the spans the classifier is fed)
                NOT a set of cut positions — it overlaps
```

Overlap is a **correctness** requirement, not an optimisation: without it a turn
sitting exactly on a seam would be invisible to every input. The cut positions
come from the separate, non-overlapping **cut positions** (see above).

## The detector's answer

```ts
detect(content): { word: string; index: number; score: number } | null
```

`word`/`index` are a **lexical hint** — they say WHICH segment turned; they never
position the cut. `score` is the model's `P(turn)` for the whole segment.

`null` means *no turn* — and, because the SDK cannot distinguish the two, also
*detector unavailable*. In both cases crossroad does **not** fire: the response
passes through untouched and is delivered as written. mycc deliberately keeps
**no fallback detector**: the package's own types suggest the caller fall back
"e.g. to a regex detector", and that is exactly what this repo used to do and no
longer does. A local heuristic would disagree with the trained model precisely
where the model is trusted most. Observability is not the compensation either:
detection that ran and found nothing logs nothing, so a missing server and a
response that never turned are indistinguishable in the verbose log.

**Unit of `index`: CODE POINTS, not UTF-16 units.** The detector indexes by code
point; `String.prototype.slice`, which mycc cuts with, counts UTF-16 units. The
two agree for pure-BMP text and differ only by the number of astral characters
before the offset (each 1 code point, 2 UTF-16 units). mycc converts exactly
once, in `codePointIndexToUtf16`; downstream stays UTF-16.

## What mycc uses today: the trainer lattice, plus consumer normalisation

The runtime cut grid is the package's `segmentsOf(content, { splitPolicy: 'trained' })`
— from `@pkubangbang/crossroad-detector@0.2.1`, which is `build_segments` from the
trainer byte-for-byte (verified by the package author over all 4,319 corpus
documents). mycc's own boundary rules (`\n\n`, `.!?` + whitespace, `。！？`) are
**gone**: the grid is the trainer's sentence lattice and nothing else.

The seam is wired: the host calls `initCrossroad(segmentsOf)` once at module load,
and `segmentsOf(content)` returns `{ start, end, cutKind }` with **exactly one**
code-point -> UTF-16 conversion. The grid contract is pinned against the installed
package in `src/tests/crossroad/package-segmenter.test.ts` (raw spans, the
`clause` label as the port-drift detector, and boundary legality), and the cut
invariants in `src/tests/crossroad-cutpoint.test.ts`.

### Consumer normalisation: N1–N4

The package reports the character lattice the model's spans were built over. A
CUT consumer needs a different object — the unit a reader saw — and `segmentsOf`
performs exactly four normalisations, none of which is a trainer rule:

| Rule | What it fixes | Bad outcome it prevents |
|---|---|---|
| **N1 coverage** | the lattice is not a partition (whitespace-only parts are dropped, a whitespace tail is not emitted), so each gap is filled by extending the unit before it | `segAt`'s binary search falling into a hole and answering "nothing to cut" |
| **N2 sentences, not clauses** | a `clause`-closed part is carried into its sentence | replacing 8 characters (`"However,"`) the model never judged, and starting the continuation mid-sentence |
| **N3 no cut on a newline** | the cutpoint is the unit trimmed; a unit may end on the paragraph mark that closes it, or on a trailing whitespace run | a cutpoint that begins or ends on whitespace, showing a dangling blank line |
| **N4 no cut inside a number** | a unit with EITHER edge inside a numeric token (`0.9.7`) is carried forward like a clause | replacing `'9.'` — a fragment of a version number |

The test that decides whether a rule belongs here: **a consumer rule survives
only if the bad user-visible outcome can be named**; a package rule survives only
if it is in the training data, checked by diffing the two lattices over the
corpus. N1–N4 are all of the first kind. `forced` is never carried by any rule:
it may sit inside a word, so it stays a boundary callers must refuse.

**A fact belongs to the layer whose evidence produced it** — a fixture fact may
become a fixture assertion, only evidence spanning the corpus may become a
package invariant, and anything else must be restated as a property checkable
without that layer's data. That principle says which claims are *legal*; its
trigger says when you are about to break it:

> **Before promoting a claim one layer up, name the layer the evidence came from
> — out loud, in the test or in the commit message.** If the sentence reads "the
> fixture shows X, so the package guarantees X", the promotion is visible in the
> wording and stops there.

It earns its keep in this file's own history: a decimal look-ahead justified by
"mycc wants sentence cuts" (consumer layer) was once pushed into the package's
`build_segments` (package layer); and this document's raw-lattice test briefly
asserted "0.2.1 no longer reconstructs" from one fixture (fixture layer) as if it
were a package guarantee. Both were caught by measurement one layer down, not by
reasoning — and the assertion that survived, **boundary legality**, is the only
one whose every clause is checkable without a corpus *and* without a fixture, so
it cannot be promoted incorrectly.

The mirror, for a package invariant: **a wrong build must be unable to satisfy
it.** Boundary legality qualifies. Reconstruction does not — a *correct* build
over a fixture with no dropped parts passes an assertion that "the raw spans do
not rejoin", and a *wrong* build over this document's EN fixture fails it for the
right-looking reason.

**Instrument first, rules second.** N1–N4 were written first and justified
second; they survived the 0.2.0 → 0.2.1 lattice change unmodified, which is the
evidence they are consumer rules — but they survived *by luck as much as by
design*, because the audit ran last. A rule list written first and justified
second is a list you cannot trust until a change arrives, and the change is
exactly when it is too late to notice the line with no justification. Name the
rule's bad outcome before writing it.

Consequence for the returned grid: it IS a partition of the text (ascending,
contiguous, `0..length`), while the raw package output is not. That guarantee is
produced by N1 and must not be assumed of the package.

## The open design question — one, not several

A cut position can be much finer than 224 code points: it is built from punctuation
boundaries plus tiling, and those positions are *cut candidates*, not units the
model scored. So the real question is not "which granularity" but:

> **How far may a cut sit from the segment the classifier actually flagged?**

The classifier's verdict is per segment (224–448 cp); the hint gives a `word`
inside it. A cut at a punctuation boundary near the start of the flagged segment,
or near the turn word, can be 200+ code points apart while both are "inside the
flagged segment". That offset is currently unbounded, and it is the whole
substance of the decoy-connective problem.

- **Cut at the flagged segment's start.** No guessing; the replaced block is
  argument-sized (224–448 cp), which is a user-visible product decision.
- **Cut at the hint's punctuation boundary.** More readable; but `word` cannot
  locate a position inside a segment, so the distance from the real turn is
  unknown — a bound on it would need a *new signal from the model*.

mycc cannot settle this alone and should not pretend a heuristic can. Until it is
settled, mycc cuts on its own sentence-level boundaries and is approximate by
construction; that approximation is documented, not hidden.

## The cut, as implemented today

`segmentsOf` is the single interpreter: the package's trainer lattice (see above),
normalised by N1–N4. Every unit is a **sentence**: for `"However, the real issue
is in the API layer."` the unit is the whole sentence, not the turning word and
not the clause.

Placement:

- A hint ON a paragraph break belongs to the paragraph that closes with it — the
  break is the unit's final characters, and the cut trims them, so the cutpoint
  never begins or ends on whitespace (`segmentStartAt` answers "which unit's text
  does this offset lie in").
- `segmentStartAfter` is the explicit "the turn is what gets said next" rule: it
  skips a unit the cut cannot start in.

Two guards keep the cut worth taking — `MIN_PREFIX_LENGTH = 30` and
`MIN_REMAINDER_LENGTH = 15`, both in **original-text offsets**. A turn inside the
FINAL unit has no remainder: that unit is replaced **whole** (`cutEnd` is its end,
trailing whitespace excluded), so the mid-text remainder guard does not apply
there — there is no after-it to protect.

Measured recall on 70 real assistant answers from a live session (hint swept every
40 characters, first usable hint taken):

```
usable                     46  (65.7%)
non-empty prefix < 30      19  (27.1%)   every one starts at offset 0 behind a long first sentence
no cuttable unit (forced)   5  ( 7.1%)   unpunctuated runs
empty prefix < 30           0
mid-text remainder < 15     0
```

The remaining loss is the prefix guard on documents whose first sentence is long —
a property of "the turn is in the first sentence", not of the grid.
## Rejected approaches (kept so they are not re-invented)

- **A local turning-word regex.** Deleted — it disagreed with the trained model
  exactly where the model is trusted most.
- **A character-shape heuristic for "this boundary is a tiler cut".** Written,
  then deleted: with the local segmenter every boundary is punctuation-derived,
  so the predicate had no signal and only rejected legitimate cuts. The exact
  answer is the package's `cutKind` label: `'forced'` means the producer hit its
  size cap, so the boundary may sit inside a word and is refused.
- **Refusing clause units without joining them.** Tried, wrong: refusing a
  clause boundary moves the cut FORWARD to a unit that begins mid-sentence (the
  rest of the same sentence) — worse than either extreme. The replacement unit
  must be the sentence, so a clause is JOINED into its sentence, not skipped.
  (The 0.2.1 grid still reports the clause as its own span, `cutKind: 'clause'` —
  that label is how a drifted port is caught, since N2 makes every visible cut
  identical either way.)
- **A host-side coalescing layer as a workaround.** Tried and reverted: merging
  clauses in mycc to paper over a coarse grid put a mycc rule where the evidence
  belonged to the package. The package now ships the trainer lattice; N2 remains
  only as a stated choice about the replacement unit.
- **A decimal guard inside the package.** Rejected for the same reason in
  reverse: `_SENT_SPLIT` is what the model was trained under, so the package must
  equal `build_segments`; the "do not cut inside a number" rule is N4, in mycc.
- **A `markers` count on the wire.** Dropped after measurement: both training
  corpora contain zero samples long enough to produce a second segment, so the
  field would have been present and never informative.
- **Per-segment scores.** Not recoverable from this model — one `P(turn)` logit
  per segment, and cumulative-prefix probing does not recover a finer signal
  (a genuine `However` case scored 0.0567 whole, 0.4261 at its best prefix).
  It would be a retrain, not an API.

## Known limitations

- **Sentence-boundary blindness.** The classifier sees whole segments; a turn
  buried mid-sentence with no punctuation around it is easy to miss. A property
  of the unit, not a bias for or against any word.
- **A decoy connective can supply the hint.** `word`/`index` name the FIRST
  connective in the scored segment, so an innocuous earlier "but that was
  expected" before the real turn hands back the earlier word's offset — and that
  offset is exact, so nothing downstream flags it. mycc cannot detect it
  (nothing in the response says which clause the model reacted to) and does not
  guess. Treat the hint as "the first turn-like connective in the segment".
- **Segments can cut inside structure.** A boundary may fall inside a fenced
  code block, a quoted sentence, or a list item, because boundaries are decided
  by punctuation alone. When that happens the replaced text can be half a code
  block. Whether the segmenter should refuse such boundaries is a segmenter-side
  question, not something mycc can paper over with a threshold.
- **The prefix guard counts characters, not claims.** `MIN_PREFIX_LENGTH = 30`
  asks "is there enough text in front that replacing the rest reads as a pivot
  rather than a deletion?" — a boundary between *almost nothing* and *a claim*.
  Characters express that boundary exactly: an empty prefix means "no claim at
  all" in every language. But CJK carries more claim per character, so a guard
  tuned on Latin is mildly permissive for CJK: eight CJK characters can be a
  whole clause where eight Latin characters are a fragment. Closing that gap
  needs a reading study (matched Latin/CJK pairs, the length at which readers
  stop accepting the replacement as a pivot), not a corpus statistic — which is
  why it is recorded here rather than implemented.
- **A short prefix can be a poor one to display.** A 20-character prefix that
  begins with whitespace and a git hash is long enough for the guard and
  unhelpful to read. `MIN_PREFIX_LENGTH` must not grow a heuristic for this —
  the same reasoning that deleted the character-shape guard: a plausible
  mechanism applied where the information does not exist. If it ever matters,
  the fix belongs in the display step (trim, start the shown text at a sentence
  boundary), not in the cut guard.

### Calibration evidence for the two guards

Both were checked against a labelled corpus rather than assumed. Measured over
1068 positive samples, using the corpus's own turn offset (`proxied = 0` — every
row carried a labelled offset, none fell back to a regex proxy, which would have
reported a confident number about the wrong quantity):

```
prefix    p10 0 | p25 68 | p50 105 | p75 158 | p90 200
remainder p10 92 | p50 172 | p90 270

MIN_PREFIX_LENGTH = 30    → rejects 12.1%   (116 of those 129 have an EMPTY prefix)
MIN_REMAINDER_LENGTH = 15 → rejects  0.3%
```

The only material bucket is **1.2%** — 13 samples with a *real* 20–29 character
prefix, i.e. documents where the pivot follows one short claim. So on mycc's own
transcripts anything far above ~1% in that bucket is a mapping fault rather than
a guard fault: the cut is landing before the turn.

These guards are stated in **characters of text**, which do not change when the
segmentation grid changes — that is why they survive the adoption of the
package's cut positions. An earlier concern that they would reject 76% of turns
came from measuring the spacing *between adjacent cut positions*, a different
quantity: a turn usually sits *inside* a cut unit, so short units mean short
gaps while the prefix stays long.

### A guard is calibrated against a GRID, so a grid change re-weights it

The guards are measured in characters, but *which unit is replaced* is decided by
the grid — so a new lattice silently re-weights both guards without either number
changing. Measured on the same session across the 0.2.0 → 0.2.1 swap: usable
stayed at 46, while `non-empty prefix < 30` moved **10 → 19**, because the
trainer lattice does not split a unit at a paragraph break the way 0.2.0 did, so
more hints land on offset 0 of a long first sentence. Nothing about the prefix
guard changed; only the grid did.

The honest outcome there was "the number moved and we accept it" — and that
outcome is only safe because it was written down. So **every package release that
changes the grid carries this checklist**, and it is run before the release is
adopted, not after:

a. the raw-lattice **boundary-legality** test (every span ends on a split
   character; no span start inside a numeric token) — the only failure mode that
   survives every fixture;
b. the **`cutKind` drift assertion** on a known clause boundary (N2 makes every
   visible cut identical whether that label is `clause` or `sentence`, so the
   label is the sole trainer signal that survives normalisation);
c. **re-measure the three guard buckets** — `prefix`, `remainder`, `no-cut` — and
   report the delta even when it is "no change";
d. confirm **N1/N2/N4 pass unmodified**. That they pass unchanged is the
   evidence that they are consumer rules rather than reactions to one grid's
   shape; a rule that has to change with the grid was a package rule in
   disguise. If one of them needs an edit, **the edit is a signal, not a fix** —
   it means that rule had a lattice assumption hiding in it, and the edit itself
   must be justified by a bad user-visible outcome before it lands. Otherwise a
   grid change can "pass" by quietly re-fitting the consumer rules, which is the
   same failure as re-deriving a guard.


## Continuation generation

Three directions, run in parallel via `Promise.allSettled`. Each prompt carries
the prefix and requires the model to begin by repeating the anchor sentence —
the last sentence of the prefix — so the continuation dovetails instead of
restating. `stripAndValidate` removes the anchor; a continuation that does not
start with it is retried once and then dropped.

Selection is a second `forkChat` over the surviving candidates.

## Record and display

The record reads, in order: **prefix → cutpoint → continuation**, with `original`
(the replaced tail) and `candidates` alongside. A card renders the cutpoint and
the candidate list; deferred hook messages are injected, the six
`chat.crossroad*` fields (`crossroadContinuation`, `crossroadFilePath`,
`crossroadCandidates`, `crossroadSelectedIndex`, `crossroadCutpoint`,
`crossroadOriginal`) are cleared, and the flow returns to `COLLECT`.





---

## Review fixes (2026-11-09)

A line-by-line review of the 0.2.1 swap found nine consumer-side defects. Every
one is fixed in mycc; **nothing in the package changed**. Each fix has a named
regression test — src/tests/crossroad-review-regressions.test.ts,
src/tests/loop/states/hook-crossroad-merge.test.ts, and the cooldown case in
llm-esc-crossroad.test.ts.

| # | Defect | Fix |
|---|---|---|
| 1 | The merge committed after HOOK's `await` even when ESC had cancelled the turn. | hook.ts drops the resolution when neglected mode is armed and clears the fields. |
| 2 | A compact request in the same pass dropped a paid-for crossroad with no note or event. | Reported as `crossroad_skipped {reason: 'compact'}` plus a brief, then cleared. |
| 3 | The selector's free text won over the option it named, so `selectedIndex` became -1 and the card showed no winner. | selectBestContinuation returns `{text, index}` together; a paraphrase is discarded in favour of the named draft. |
| 4 | N4's closing-edge test looked only left, so any digit + '.' glued the next sentence in and the cut slid backward. | The separator must have a digit on BOTH sides (dgeInsideNumber). |
| 5 | The N3 trim was gated on `start < offset`, so a hint exactly on a whitespace-leading unit emitted a cutpoint starting with a space. | The trim runs on the chosen boundary, independent of the hint. |
| 6 | `cutEnd` could be a `'forced'` size cap, splicing the continuation mid-word. | A `'forced'` closing boundary is refused; the reply passes through. |
| 7 | An unusable producer offset was silently rewritten into a plausible unit. | Any non-ascending, out-of-range, or non-integer offset refuses the whole grid. |
| 8 | Both guards compared UTF-16 offsets, so astral text halved the effective threshold. | `charLength` counts code points — the guards are character statements. |
| 9 | `cutText` module global made `canCutAt` depend on the last `segmentsOf` call. | `content` is a parameter; the global is gone. |

Beyond the nine:

- **The anchor comes from the grid.** xtractWordsBeforeTurn no longer carries a
  private sentence regex. That regex required whitespace after `。`, so Chinese
  text collapsed to one "sentence" and the anchor became the ENTIRE prefix — every
  direction was asked to repeat it verbatim, none could, and crossroad abandoned
  nearly every Chinese reply. A second producer of sentence boundaries was the
  layering defect; the anchor now reads the same lattice the cut does.
- **A failed generation is charged.** When detection fires but no usable cut or
  continuation comes out, the cooldown is armed and `+2` confusion is applied.
  Previously the pass reset the flag, so each pass paid up to seven `forkChat`
  calls and the hint escape valve never advanced. Reported as
  `crossroad_skipped {reason: 'generation_failed'}`.
- **The cooldown is cleared at the turn boundary**, in state-machine.ts next to
  `skillSuggester.reset()`. The three resets in `prompt.ts` sit on the input
  paths, which return AWAIT before reaching them, so an armed flag could leak into
  the next turn and silently skip detection in auto mode.
- **`stripAndValidate` checks restatement before the empty-anchor early return**,
  so a continuation that merely restates the prefix is not appended twice.
- **Observability.** `crossroad_skipped`, `crossroad_fired` and
  `crossroad_merged` are now in `LoopEventPayload`. "Detector silent", "guard
  refused", "generation failed", "ESC", "compact" and "merged" are distinguishable
  to a listener; before, only verbose lines differed.

**Known limitation, recorded rather than hidden.** When the turn's own unit ENDS
at the producer's size cap, refusing the cut is the only safe move — extending the
end forward would leave a fragment that is neither replaced nor kept. The reply
passes through, and the regression test pins this as a characterisation so a
future lattice change has to look at it.