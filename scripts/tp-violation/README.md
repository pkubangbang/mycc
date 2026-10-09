# tp-violation — the illegal tool-call interposition, and how to witness it

## The rule every provider enforces (but only some complain about)

An OpenAI-compatible chat history must satisfy:

> **An `assistant` message carrying `tool_calls` MUST be followed by `tool`
> messages answering *each* `tool_call_id`, before any other role appears.**

mycc's `Triologue` builds that history. When a `note()` or `user()` submission
lands while tool calls are still **outstanding** (the `PendingToolLedger` is
non-empty), mycc used to append it immediately, producing:

```
user → assistant(tool_calls: p1) → user([REMINDER] …) → assistant(synthetic) → tool(p1)
         ▲──────────────────────── tool_calls still unanswered ────────────────────▲
```

DeepSeek rejects this with **HTTP 400**:

```
An assistant message with 'tool_calls' must be followed by tool messages
responding to each 'tool_call_id'. (insufficient tool messages following tool_calls message)
```

**Ollama accepts it.** That asymmetry is why the defect survived: the dev
provider silently tolerates a sequence that the production provider refuses.
A guard that only checks `lastRole === 'assistant'` is *not enough* — see
"the case that hides from a naive guard" below.

## Run it

The harness is split into four modules so each provider is graded against its
**own** expected-result table:

| Module | Role |
|---|---|
| `main.mjs` | CLI arg handling only — routes to a provider leg (`--provider=deepseek\|ollama\|both`) |
| `lib.mjs` | fixtures: builders, `isIllegal()`, and the 60 `SEQUENCES` with **both** expectations (`wantDeepseek` + `wantOllama`) |
| `deepseek.mjs` | the **strict** leg — posts to DeepSeek, grades against `wantDeepseek` (27 accepted / 33 rejected) |
| `ollama.mjs` | the **permissive** leg — posts to Ollama across **multiple models** (`deepseek-v4.1-flash:cloud`, `gemma4:cloud`), grades each against `wantOllama` (60 accepted / 0 rejected) |
| `lib/cli.mjs` | shared bootstrap: `tsx` loader, flag parsing, facade loader, phases 1 & 3 |
| `probe.mjs` | legacy all-in-one, kept for continuity |

```bash
node scripts/tp-violation/main.mjs                         # default: deepseek
node scripts/tp-violation/main.mjs --provider=deepseek
node scripts/tp-violation/main.mjs --provider=ollama
node scripts/tp-violation/main.mjs --provider=both         # run both legs
node scripts/tp-violation/ollama.mjs --ollama-models=gemma4:cloud   # one ollama model only
node scripts/tp-violation/probe.mjs --mock                 # offline, CI-safe (phase 1)
```

The ollama leg runs the whole matrix once per model (default
`deepseek-v4.1-flash:cloud` **and** `gemma4:cloud`), because "Ollama tolerates it"
is a claim about the serving layer and must not silently hinge on which model
happens to be configured. Its exit code is 0 only when **every** model accepts
all 60 shapes.

Each leg registers the `tsx` ESM loader (via `lib/cli.mjs`) so it imports the
TypeScript facade directly — no build step — and pins `process.env.API_PROVIDER`
**before** importing the provider layer. That pin is load-bearing: without it
the process silently falls back to whatever `~/.mycc-store/.env` says (ollama on
this machine), and a "deepseek" run would post to the permissive provider —
60 accepted, a clean sweep that proves nothing. `main.mjs` therefore spawns its
legs with `node --import tsx`, so the loader is in force before the child's
first static import graph links.

Exit code `0` when the run is **conclusive**; `1` on transport errors, a missed
expectation, or an all-accepted DeepSeek sweep (so a silent provider misroute is
never mistaken for a pass).

### What it does

| Phase | Question | Basis |
|---|---|---|
| 1 | Does the **real facade** build an illegal sequence? | drives `Triologue` through a 17-case producer-order matrix; judges its own `getMessages()` |
| 2 | Does the **provider** reject the facade's own bytes? | posts each illegal sequence via `retryChat` — no hand-mocked messages |
| 3 | How tolerant is the provider itself? | hand-built wire cases A–E, isolating provider behaviour from mycc's |
| 4 | What are the **exact** pairing rules? | 60 hand-built complete conversations (`SEQUENCES`) spanning the whole role algebra, each posted to the live provider; the local `isIllegal()` is graded against the provider's verdict, so a blind spot surfaces as a MISMATCH row |

Run only phase 4 with `--sequences`; print every row with `--verbose`.

Phase 1 is the local invariant (mirrored as unit tests in
`src/tests/loop/triologue.test.ts`, `deferred-input guard`). Phase 2 is the
wire-level witness: it proves the invariant **matters**, by showing the provider
refusing the exact bytes mycc would have sent.

## Observed results — AFTER the fix (2026-10-09)

Phase 1 — **0 of 17 producer mixes build an illegal sequence** (invariant
breaches: 0). Phase 2 is therefore **skipped**, because there is nothing
illegal left to post — the facade never produces the shape. Phase 3 still runs,
and shows the tolerance split unchanged:

| Case | Shape | DeepSeek | Ollama |
|---|---|---|---|
| A_legal | `assistant(TC) → tool → user` | ACCEPTED | ACCEPTED |
| B_interposed_note | `assistant(TC) → user(note) → tool` | **REJECTED 400** | ACCEPTED |
| C_empty_assistant_bridge | `assistant(TC) → assistant('') → user → tool` | **REJECTED 400** | ACCEPTED |
| D_orphaned_tool_calls | `assistant(TC) → assistant → user` | **REJECTED 400** | ACCEPTED |
| E_second_call_unanswered | `assistant(TC p1,p2) → tool(p1) → user → tool(p2)` | **REJECTED 400** | ACCEPTED |

Baseline `A_legal` accepted by **both** providers, so the phase is meaningful
(a provider that rejects everything would prove nothing).

Both live runs reported `invariant breaches: 0`, `baseline A_legal accepted:
yes`, `transport errors: 0` → **CONCLUSIVE ✓**.

## Observed results — PHASE 4: the 60-case sequence matrix (2026-10-09)

Each leg grades the same 60 cases against its **own** expectation table.

`node scripts/tp-violation/main.mjs --provider=deepseek --sequences`

```
cases: 60   accepted: 27   rejected: 33
expectation mismatches: 0   checker-vs-provider mismatches: 0
transport errors: 0                         → CONCLUSIVE ✓
```

`node scripts/tp-violation/main.mjs --provider=ollama --sequences`

```
cases: 60   accepted: 60   rejected: 0
expectation mismatches: 0   checker-vs-provider mismatches: 0
transport errors: 0                         → CONCLUSIVE ✓
```

> Both legs are now **green**, and that is the whole point: the same 60 cases
> carry `wantDeepseek: illegal` / `wantOllama: legal` for the 33 rule-breaking
> shapes, so DeepSeek rejecting them is a PASS and Ollama accepting them is also
> a PASS. The disagreement between the two providers *is* the finding — it is not
> a checker failure. (Before the split, the Ollama leg graded against DeepSeek's
> rule and necessarily exited `1`.)

### What the provider actually enforces (measured, not documented)

The invariant is broader than "no non-tool role interposed". `isIllegal()` was
widened to a **full pairing walk** with three rejection rules:

1. **Interposition** — a non-`tool` role (note/user/assistant/system) appears
   while a `tool_call_id` is still unanswered. Includes a second assistant block
   opening before the first is answered. Cases 14–21, 24–27.
2. **Orphan / duplicate / foreign tool result** — a `tool` message whose id was
   never announced, or was already answered. Cases 28–37, 39, 43, 52, 55, 60.
3. **Trailing unanswered block** — the conversation *ends* mid-block.
   `user → assistant[p1]` and `user → assistant[p1,p2] → tool` are **REJECTED**
   (`insufficient tool messages following tool_calls message`). Cases 22, 23, 41.

Finding (3) overturned the earlier assumption that a trailing block is a legal
"in-flight" state: at the wire level there is no legal in-flight shape. The
facade must answer (or drop) every block before it ever posts.

### Surprises worth recording

| # | Sequence | Verdict | Lesson |
|---|---|---|---|
| 06 | parallel calls answered **REVERSED** (`p3,p2,p1`) | ACCEPTED | results may be answered in any order — only the *set* must close, not the sequence |
| 11 | `assistant(TC) → tool → assistant('') → assistant(answer)` | ACCEPTED | the earlier "empty-assistant bridge is fatal" (phase-3 case C) was a **false attribution** — that case also interposed a note; the empty assistant alone is fine |
| 09 | `user → user → user` | ACCEPTED | consecutive user turns are legal, so note/user *merging* is a product choice, not a provider constraint |
| 38 | `assistant[p1,p2] → tool(p2) → assistant[p3] → tool(p1) → tool(p3)` | REJECTED | the second assistant is interposed while `p1` is pending — rule (1), not a separate "answer belongs to a later block" rule |
| 45 | assistant with **empty `tool_calls: []`** | ACCEPTED | an empty array announces nothing; it is a plain assistant message |
| 47 | tool result with **empty content** | ACCEPTED | content emptiness is irrelevant — only pairing matters |
| 49 | `system` message mid-conversation | ACCEPTED | a mid-history system turn does not violate rule (1) |

### Before/after on the checker

The first live run of phase 4 reported **13 checker mismatches** (rows where
`isIllegal()` said "legal" but DeepSeek returned 400): cases 28–37, 39, 40, 43.
Every one was a rule-(2) or rule-(3) shape the narrow interposition-only walk
could not see. After widening `isIllegal()`, the checker column is **0** — which
is what makes the suite a usable CI gate rather than a provider-only oracle.

## Observed results — BEFORE the fix (ablation, same matrix)

Neutralising the guard (making the `ledger.size > 0` checks no-ops) and re-running
the offline matrix reproduces the defect on **12 of 17** cases, e.g.:

```
[BAD] note() with 1 call pending
      user → assistant[p1] → user → assistant[tp_recovery_…] → tool   ← ILLEGAL
[BAD] multi-call: note BETWEEN the two results
      user → assistant[p1,p2] → tool → user → assistant[tp_recovery_…] → tool   ← ILLEGAL
[BAD] note deferred across an ESC interrupt
      user → assistant[p1] → user → tool   ← ILLEGAL
```

The five that stay legal without the guard are the ones that never interpose
(agent→tool→note turn boundary, note after the last result, `skipPendingTools()`
then note, a second `agent()` — which clears pending via the duplicate-assistant
recovery — and `clear()` with a deferred note). That before/after delta is what
proves the guard is **load-bearing**, not decorative: it is the only thing
standing between the facade and 12 illegal shapes.

## The case that hides from a naive guard

```
assistant(tool_calls: p1, p2) → tool(p1) → note() → tool(p2)
                                            ▲
                    lastRole === 'tool', but the ledger still holds p2
```

Here `lastRole` is `'tool'`, so a guard written as
`lastRole === 'assistant' && ledger.size > 0` **passes this through** to the
existing `note_after_tool` branch — which returns `'allowed'` for
ollama/deepseek — and the note is appended, orphaning `p2`. Exactly the 400
reproduced above.

**The correct predicate is `ledger.size > 0`**, checked at the top of both
`note()` and `user()`, *before* the `lastRole === 'tool'` branch. It names the
invariant — *"no user/note while tool_calls are outstanding"* — instead of the
role, and collapses assistant-pending, mid-batch, and note-after-tool-with-
outstanding-calls into one deferral.

## The fix (defer + replay)

1. **Defer**: while `ledger.size > 0`, buffer the submission and return —
   append nothing. This also kills a **cascade**: because the note no longer
   falls through to `addMessage`, `tool()` still sees `lastRole === 'assistant'`,
   so `tool_no_assistant` never fires and no spurious second synthetic assistant
   is injected.
2. **Replay** after the **last** pending result resolves (`ledger.size === 0`),
   by **re-invoking the producer** — never by hand-rolling the append. A
   `'merge'` piece emitted after a tool record folds onto the wrong host on
   replay (`transcript.ts` folds merges by stream position).
3. **Force standalone at flush**: a deferred genuine `user()` must not merge
   into a deferred note's message, or the query is buried under a system note
   *and* `lastUserQuery` is polluted with the combined text.
4. **Flush-or-drop** on `clear()` / `compact()` / `beginWrapUp()` /
   `truncateAndRecount()`. A deferred buffer surviving `compact()` is the worst
   failure mode: it injects into a context whose pending call no longer exists.
5. Never use the **empty-assistant bridge** — DeepSeek 400s on it (case C).

## Files

- `main.mjs` — CLI arg routing (`--provider=deepseek|ollama|both`, plus `--sequences`, `--verbose`, `--mock`).
- `lib.mjs` — the shared fixtures: builders, `isIllegal()`, and the 60 `SEQUENCES` with `wantDeepseek` + `wantOllama`.
- `deepseek.mjs` — the strict provider leg (grades against `wantDeepseek`).
- `ollama.mjs` — the permissive provider leg, run once per model in `OLLAMA_MODELS`
  (default `deepseek-v4.1-flash:cloud,gemma4:cloud`; override with `--ollama-models=a,b`).
- `lib/cli.mjs` — shared bootstrap (tsx loader, flags, facade loader, phase 1 / phase 3).
- `probe.mjs` — legacy all-in-one harness, kept for continuity.
- `README.md` — this document.
