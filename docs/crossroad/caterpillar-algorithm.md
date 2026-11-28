# The Caterpillar Algorithm

> **Status:** Implemented in `@pkubangbang/crossroad-detector@0.2.1`
> (`src/chunker.ts`, a 1:1 port of `trainer/chunker.py`). mycc does **not**
> implement it; this document records what the package does, because every
> behaviour of the crossroad feature — including where a cut may land — is a
> consequence of it.

## Why the name

The window that the classifier is fed grows by **appending to its tail, then
retracting from its head**, so its total length stays roughly constant while it
crawls forward over the text:

```
tail appended  ──►  ┃▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓┃
head retracted ──►        ┃▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓┃
                          ▲ overlap ▲
```

A span is never re-cut from scratch at a new offset. It keeps the text it
already has as its head and reaches further right, then releases the left edge.
Consecutive spans therefore **overlap**, and the overlap is what makes a turn
that happens to sit on a seam visible from more than one offset.

## The three moves

Input text is first reduced to the smallest unit — a **chunk** — by splitting
after sentence-ending and clause punctuation:

```
SENT_SPLIT = /(?<=[.!?,;:\n。！？，；：])/
```

`" However,"` is one chunk, 9 code points. Chunks are then assembled into the
window in three named moves (`chunker.ts`):

| Move | Function | Cap | Effect |
|---|---|---|---|
| **Glue** | `buildSegments` + `growSuffixTo` | `SPAN_TARGET_MAX = 448` | merge adjacent chunks until the span reaches the target |
| **Append tail** | `growSuffixTo` | `SPAN_GROW_MAX = 672` | extend the right edge past the target so the head can move |
| **Retract head** | `shrinkPrefixBelow` | `< SPAN_TARGET_MAX = 448` | drop left chunks only until the span is under the target again (minimal drop = maximal overlap) |

`CLAUSE_TILE_MAX = 224` is the last-resort cap: a single chunk longer than 224
code points is tiled at exactly 224, which is the only boundary in the system
that does not follow punctuation.

The window then crawls: append → retract → emit → append → retract → emit,
until the end of the text, where a final span is emitted that reaches the true
last code point.

## What the classifier answers

Each span is fed to the model **separately**, and the answer is one probability
for that whole span:

```
P(turn | this 224–448 code-point window)
```

The model never says *where inside the window* the turn is. It says *whether
this window contains one*. Everything downstream therefore inherits one rule:

> A detector answer is evidence about a **window**, not a position.

## Consequences mycc depends on

1. **Spans overlap, so spans are not cut positions.** At a given offset two
   spans can both contain the text. A cut replaces exactly one unit, so cut
   positions must be a *partition*. This is why the package exports
   `segmentsOf` separately from `buildSpans` and deliberately does not export
   the spans: they are the model's input, not a place a reader may be cut.
2. **Overlap is a correctness requirement, not an optimisation.** Without it a
   turn sitting exactly on a seam would be invisible to every window.
3. **The window is measured in code points of the text, not in meaning.** See
   below — this is where the geometry stops being language-neutral.
4. **The `word` / `index` pair is a lexical hint.** The server extracts it with
   `win.match(HINT)` — the *first* connective in the winning window. It names
   which connective is present; it never reports where the turn is. With a
   single window (see below) it degenerates to "the first connective in the
   whole reply".

## Short text: the caterpillar does not crawl

The caps are stated in code points, and the crawl only begins once the text is
long enough for the tail to reach `SPAN_GROW_MAX` and the head to then retract.
Below that length, **append consumes the entire text in one move and retract
has nothing to do**: one span, `[0, text.length)`, overlap zero.

Measured with the shipped `buildSpans`:

| text | code points | spans | first span | overlap |
|---|---:|---:|---|---:|
| English | 655 | 2 | `[0, 395)` | 173 |
| Chinese | 28 | 1 | `[0, 28)` | 0 |
| Chinese | 116 | 1 | `[0, 116)` | 0 |
| Chinese | 256 | 1 | `[0, 256)` | 0 |
| Chinese | 384 | 1 | `[0, 384)` | 0 |
| Chinese | 512 | 2 | `[0, 448)` | 374 |

A code point of Chinese carries roughly three times the information of a Latin
character, so the same 448-code-point cap covers a far larger semantic span:
Chinese text must reach 448 **characters** — on the order of 750 English words
— before a second window (and therefore any overlap) exists. Ordinary Chinese
replies of 100–300 characters are single-window by construction.

Single window has two consequences for the crossroad feature:

- the "seen twice, once from the second half and once from the first half"
  property does not hold, so there is no positional evidence at all;
- `score` becomes a document-level classification, "does this reply turn
  somewhere".

mycc therefore does **not** attempt to locate a cut from the model's answer.
It cuts at the start of the sentence the hint lands in (see
`crossroad-design.md`), which is why the precision of `index` and of the window
geometry does not affect the cut.

## Where the geometry is language-neutral and where it is not

| concern | unit | language-neutral? |
|---|---|---|
| chunk boundary | punctuation | yes |
| span geometry (224 / 448 / 672) | code points | **no** — a CJK code point carries ~3× a Latin one |
| turn probability | per span | yes |
| cut placement | sentence grid (`segmentsOf`) | yes |
| cut usability guard | **effective length** | yes — see `crossroad-design.md` |

The span geometry is the only non-neutral part, and it degrades gracefully: it
loses *positional* evidence for short CJK text, which the feature does not use.
The cut itself is placed on the sentence grid, whose units are punctuation —
identical in every language.

## Effective length

The guard that decides whether a cut is worth taking is stated in **effective
length** — the number of display columns a string occupies, with leading and
trailing whitespace ignored:

| character class | weight |
|---|---:|
| Latin letters, ASCII digits, half-width symbols | 1 |
| CJK ideographs, kana, hangul, full-width punctuation | 2 |

```
我先看一下配置。            8 characters, effective length 16
I will check the config first.  30 characters, effective length 30
```

That is the unit `crossroad-design.md` uses for `MIN_ANCHOR_EFFECTIVE_LENGTH`
and `MIN_REMAINDER_EFFECTIVE_LENGTH`, so a complete Chinese sentence and a
complete English sentence are judged on the same scale instead of a Latin
character count deciding for both.
