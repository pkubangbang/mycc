# Crossroad Detector — A Case Study

> **Status:** Integrated. Semantic detector (`@pkubangbang/crossroad-detector`, installed `0.1.1`) is the primary path; tiered regex is the zero-dependency fallback. Live smoke-tested 2026-09-12 (then model v6; the package has since shipped v7).
>
> **Scope:** This document is a retrospective case study — the model journey, the failed FSM detour, the extraction into a standalone package, and a live smoke test that captured a real false positive. For the feature's runtime mechanics (truncation, fork, selection), see [`crossroad-design.md`](crossroad-design.md). For cooldown behavior, see [`crossroad-cooldown.md`](crossroad-cooldown.md).

---

## 1. The Problem

When an LLM generates a long response, it sometimes **pivots mid-output** — it commits to a direction, then reverses course with a turning word ("However", "Wait", "但", "等等"). The `crossroad` feature intercepts this:

1. **Detect** the turning word.
2. **Truncate** the output at the turn (keep prefix A).
3. **Fork** — generate multiple continuations in different directions (go forward / go backward / synthesize).
4. **Select** the best continuation via the LLM.
5. **Reconstruct** the response as A + best continuation.

The hard part is step 1. A turning word is a **semantic** event — "did the model change its mind?" — not a syntactic one. The entire case study is the story of learning that lesson.

---

## 2. The Model Journey (v3 → v6)

A chunk-based DistilBERT sequence-classifier, trained on real crossroad records harvested from live mycc sessions.

| Version | What changed | Test F1 | Notes |
|---------|-------------|---------|-------|
| **v3** | baseline | 0.7255 | P=0.7758, R=0.6813 |
| **v4** | + round-3 corpus | 0.7305 | marginal — more data alone didn't help |
| **v5** | harvested-label cleanup | **0.8208** | major breakthrough: cleaned 93/120 noisy FSM-weak harvested positives. *Label quality > data quantity.* |
| **v6** | new `chunker_v2` + `--max-len 448` | **0.9050** (torch) / 0.8786 (ONNX INT8) | segment-based contiguous tile-by-cap (X_CHARS=448, SEG_MAX=224) replacing old 128-char/stride-32 windowing. ep3 did not overfit (val_f1=0.8990 best). |

**Two lessons from the progression:**

- **Label hygiene beat data volume.** v4 added a whole corpus round and gained 0.005 F1. v5 *removed* noisy positives and gained 0.09. The bottleneck was signal, not sample count.
- **Chunking is part of the model.** v6's leap came not from the classifier but from `chunker_v2` — feeding the model contiguous semantic segments instead of fixed-width overlapping windows. The inference-time representation matters as much as the training-time one.

**ONNX INT8 quantization drift:** Δlogit ≈ 0.99, recall dropped 0.8526 (torch) → 0.8000 (INT8). Shippable, but the torch artifact is the higher-accuracy reference. The deployed server runs the ONNX model for startup speed and memory; the torch model remains the training reference.

---

## 3. The FSM Detour (and Why It Was Retired)

Before the neural detector matured, a structural Finite State Machine was attempted as a replacement for the regex detector.

**The premise:** reading the output word-by-word and confirming the structural sequence `committed direction → sentence boundary → turning word → pivot` should beat pattern-matching isolated tokens. The FSM was a 589-line script-aware tokenizer + state machine (`crossroad-fsm.ts`), with its own 257-line test suite and 321-line design doc.

**The result — from the FSM's own fix commit (`37eabe4`):**

> "The crossroad FSM failed to detect a genuine turn on **85.9% of 545 real** crossroad records."

A detector that misses 86% of real turns is a no-op with extra steps. The failure mode was the tell: it wasn't a logic bug, it was **tokenizer fragility**.

- **Defect A (quote-leak, 286 nulls):** the tokenizer glued ASCII grouping punctuation into Latin runs, so `resetTurn()` became one token carrying only its `(`. The FSM counted an unmatched open, ratcheted `quoteDepth` up, and never left `INSIDE_QUOTES` — permanently swallowing every later turning word.
- **Defect B (close-bracket swallows sentence-end, 34 nulls):** a token like `diff).` was classified `P_CLOSE` with `punctEnd=false`, so the trailing `.` never flipped state to `AT_BOUNDARY` and a following `But`/`However` was rejected as mid-sentence.

The fix commit patched the tokenizer to emit `()[]{}` and CJK grouping as atomic 1-char tokens. Recall crawled from 14% → 40%. Still below the regex it replaced.

### Why it was retired

Three converging reasons:

1. **It reproduced the regex's weakness at higher cost.** The FSM traded regex false positives for a worse failure mode — silent total blindness — at 4× the code complexity. The tokenizer became the new fragile surface.
2. **The v6 semantic detector made the whole question moot.** The FSM and the neural detector were solving the same problem (regex is too shallow), but only one could read "Having said that" inside a parenthetical aside. Once a real classifier existed, a hand-built structural grammar had no justification.
3. **The maintenance cost was ongoing.** Every corpus harvest would surface new tokenizer edge cases. The regex fallback, by contrast, is ~60 lines of tiered patterns with clear, bounded failure modes.

**The deeper principle:** a crossroad is a *semantic* event (did the model change its mind?), not a syntactic one. No amount of structural grammar — regex or FSM — can read intent from punctuation alone. The FSM was solving a pattern problem with a pattern tool when a learned classifier was the right tool all along.

The two FSM commits were removed via `git reset --soft`. A backup branch (`backup/pre-fsm-cleanup-37eabe4`) preserves them. `crossroad.ts` was restored to the pre-FSM tiered-regex detector, which now serves as the permanent fallback.

---

## 4. Extracting the Detector into a Package

The ONNX encoder is a **per-machine** resource, not per-instance: one ~129 MB model shared across all mycc processes on a host. Architecture: a Node.js HTTP lambda server in a standalone npm package, `@pkubangbang/crossroad-detector`.

### Design decisions

| Decision | Rationale |
|----------|-----------|
| **Standalone npm package** | Self-contained: `npm install` gets the model + tokenizer + server + client. No `~/.mycc-store/` coupling. |
| **Detached HTTP server, random localhost port** | One process per machine; PID + port recorded in a lockfile so late-spawning clients find the existing server. |
| **15-min idle auto-shutdown** | The model is only needed during active generation; no point keeping the model resident between sessions. |
| **Server is mycc-agnostic** | The server receives its lockfile path via `--lockfile` CLI arg. The `CrossroadDetector` client (in mycc) owns the `~/.mycc-store/crossroad.lock` path. |
| **Model + tokenizer vendored in the package** | Not stored in `~/.mycc-store/`. The package is the unit of distribution. |
| **Env-gated fallback** | `MYCC_CROSSROAD_DISABLE_SEMANTIC=1` skips the semantic detector → regex fallback. Tests set this to avoid spawning a real server. |

### Rejected alternatives

- **Ollama marketplace** — incompatible: DistilBERT sequence-classification ≠ causal LM / embeddings model.
- **Go binary** — elegant, but re-implementing the HuggingFace tokenizer in Go carried unacceptable correctness risk.
- **Pure CLI binary (exit 0/1)** — too limited; the detector must return `{ word, index, score }`, not just a boolean.

### Local dev resolution

The package is published to npm as `@pkubangbang/crossroad-detector` (current: `0.1.1`), so mycc resolves it via normal registry lookup — `package.json` declares `"@pkubangbang/crossroad-detector": "^0.1.1"` and `pnpm install` fetches it like any other dependency. No `pnpm.overrides` / `link:` entry is needed.

> Historical note: while the package was unpublished, `pnpm-workspace.yaml` carried a `pnpm.overrides` entry pointing `@pkubangbang/crossroad-detector` to `link:../crossroad-detector` so `pnpm install` resolved it from the local sibling repo. That override was removed once the package was published.

---

## 5. The Integration Point

In `src/loop/crossroad.ts`, `handleCrossroad` tries the semantic detector first and falls back to regex on any failure:

```typescript
const det = await getDetector();        // lazy singleton, spawns server on first use
if (det) {
  const semMatch = await det.detect(originalContent);
  if (semMatch) match = { word: semMatch.word, index: semMatch.index };
}
if (!match) match = detectTurningWord(originalContent);  // regex fallback
```

The `getDetector()` function is a lazy singleton: on first call it dynamic-imports the package and constructs a `CrossroadDetector` with the lockfile path. If the package is missing or the server fails to start, `detectorInitFailed` is latched and all subsequent calls skip straight to the regex — no repeated spawn attempts.

---

## 6. Live Smoke Test (2026-09-12)

The smoke test was unplanned: the crossroad feature fired on the agent's *own* response while it was analyzing why the FSM was retired. This yielded a real end-to-end test plus a captured false positive.

### Server verified live

| Field | Value |
|-------|-------|
| Lockfile | `~/.mycc-store/crossroad.lock` |
| PID | 33612 (`node`) — process alive |
| Port | 52336 — confirmed `LISTENING` |
| Endpoint | `POST http://127.0.0.1:52336/detect` (body field: `text`) |

### Pipeline integrity confirmed

Detection → truncation → 3-way fork → selection → reconstruction all ran. The crossroad record was written to `.mycc/sessions/<id>/crossroad-*.json` with prefix, three candidates, and the selected continuation.

### The trigger was the model, not the regex

The agent's response used a sentence-boundary `But` introducing *elaboration* of the same argument (not a reversal). Probing the live server with that exact text:

```json
// The actual trigger text (elaboration-"But")
{ "turn": true, "word": "But", "index": 0, "score": 0.6073975588580675 }

// Control: a known pivot ("However" introducing an actual reversal)
{ "turn": true, "word": "However", "index": 0, "score": 0.997163207811875 }
```

The model scored the elaboration-`But` at **0.607** — above the `threshold: 0.5` the client sets. So the semantic detector flagged it; the regex fallback was never reached. This is a **semantic false positive**, not a regex-bleed problem.

The 0.39 gap between the two scores shows the model *can* distinguish reversal from elaboration — it just needs more elaboration-`But` negatives in its training set to push that 0.607 below 0.5. This sample is logged as a candidate negative for round-4 corpus farming.

---

## 7. Closing Word: Crossroad Reinforces Intelligence

The smoke test surfaced a false positive, and the design response is: **that's acceptable, by design.**

The crossroad's role is not to be a precision gate. It is an **intelligence amplifier**. When it fires — even on a marginal turn — the fork/select logic runs, producing a reconsidered continuation. The agent re-examines its direction and either reaffirms or improves it. The cost of a false positive is one extra generation round. The cost of a false negative is a missed opportunity to reconsider. The asymmetry favors recall.

This reframes the detector's objective. A detector optimized for pure precision would suppress marginal turns to avoid the generation cost — but that throws away the reconsideration. A detector tuned for recall (the v6 threshold at 0.5, the ONNX model's 0.80 recall even after INT8 quantization) keeps the amplifier active. The 0.607 elaboration-`But` firing is not a bug; it is the system choosing to spend a generation round to double-check a continuation that *might* have been a pivot.

The regex fallback, the semantic detector, the fork directions, and the selection step all serve this one principle: **when in doubt, reconsider.** The FSM was retired because it couldn't detect enough doubt to be worth running. The v6 model was integrated because it can.

---

## Appendix: Key Artifacts

| Artifact | Location |
|----------|----------|
| mycc integration | `src/loop/crossroad.ts` (`handleCrossroad`, ~line 508) |
| Regex fallback | `src/loop/crossroad.ts` (`detectTurningWord`, tiered STRONG / SENTENCE_BOUNDARY / SPECIAL patterns) |
| Detector package (source) | `C:\Proj\crossroad-detector\` (`src/server.ts`, `src/client.ts`, `src/lockfile.ts`) |
| Detector package (installed) | `node_modules/@pkubangbang/crossroad-detector@0.1.1` (from npm registry) |
| Vendored model | `node_modules/@pkubangbang/crossroad-detector/model/model.onnx` (~129 MB, INT8) + `tokenizer.json` |
| Trainer harness | `C:\Proj\crossroad-detector\trainer\` (`train.py`, `chunker_v2.py`, `export_onnx.py`, `validate_corpus.py`, ...) |
| Corpus farmer skill | `C:\Proj\crossroad-detector\.mycc\skills\crossroad-corpus-farmer\` |
| Dependency declaration | `C:\Proj\mycc\package.json` (`"@pkubangbang/crossroad-detector": "^0.1.1"`, registry resolution) |
| FSM backup branch | `backup/pre-fsm-cleanup-37eabe4` (preserves the retired FSM commits) |

### Commits (not pushed)

- `crossroad-detector` `6c99082` — initial release (35 files)
- `mycc` `b319734` — refactor: extract semantic detector into `@pkubangbang/crossroad-detector`

### Recorded pitfalls (wiki, domain `pitfall`)

1. **"Semantic crossroad detector spawns real HTTP server in tests"** — gate tests with `MYCC_CROSSROAD_DISABLE_SEMANTIC=1`.
2. **"pnpm install fails for an unpublished package"** — while the detector was unpublished, local resolution used a `pnpm.overrides` entry in `pnpm-workspace.yaml` with `link:../path`. Now that the package is published (`0.1.1`), the override is gone and normal registry resolution applies.