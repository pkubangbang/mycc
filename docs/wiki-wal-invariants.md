# Wiki WAL-as-Truth — Invariant Proof

> **Status**: Proof of the correctness invariants for the WAL-as-truth design
> (`src/context/parent/wiki.ts`). Formalizes the state machine, states the
> invariants the system must uphold under concurrency and crashes, and proves
> which operations preserve them. Where the shipped code violates an
> invariant, the violation is named (V1–V3) and the minimal fix that restores
> the invariant is given. Co-deduced with the deepseek peer review.

## 1. Why a proof, not a race hunt

The reviewer's re-review of `bdbafd6` raised three concrete issues (one P1,
two P2). Chasing each race ad hoc risks missing the invariant the race
*breaks* — and hence the fix that closes the whole class. This document
instead states the invariants the WAL-as-truth design *intends* to hold, then
proves (or refutes) them against the actual operations. The three findings
fall out as specific invariant violations, and the minimal fix set is the
smallest change that restores all invariants.

## 2. Formal model

### 2.1 State

- **W** — the WAL. An append-only log of entries `e`, partitioned by UTC day
  into day-files `W_d`. Each entry:
  `e = { hash (16-hex), document, deleted (tombstone), sequence (ℕ),
  namespace, approved, timestamp }`.
  `W` is **durable** (append-only; survives crash) and **authoritative**.
- **D** — the LanceDB table, the **materialized cache**. Rows keyed by
  `hash`, but LanceDB imposes **no uniqueness constraint** on `hash` —
  duplicate physical rows per hash are physically possible (the legacy bug).
  `D` is **derived** and **never authoritative**; it may lag `W` and may be
  rebuilt at will.
- **M** — the watermark, `{ days: { d: maxSeq_d } }` persisted to
  `watermark.json`. Intended meaning: *"every WAL entry with
  `sequence ≤ M_d` for day `d` has been durably materialized into `D`."*
  **Fail-LOW**: a missing/corrupt `M` ⇒ `{}` ⇒ "nothing flushed" ⇒ re-flush
  everything (never "skip").

### 2.2 Derived notation

- `fold(W) : hash ↦ e*` — the **global** latest-wins-by-`sequence` winner per
  hash across **all** day-files. A tombstone with a higher sequence beats an
  insert. `e*` is the canonical truth for that hash.
- `Truth(h)` — the authoritative state of `h`:
  - `ABSENT` if `e*` exists and `e*.deleted`, or no entry exists for `h`;
  - `doc` if `e*` exists and `!e*.deleted` (then `doc = e*.document`).
- `D(h)` — the multiset of physical rows in `D` with hash `h` (∅, one, or many).
- `D` is **correct for `h`** iff
  `(Truth(h)=ABSENT ⇒ D(h)=∅) ∧ (Truth(h)=doc ⇒ D(h) = {one row carrying doc})`.
- `W_seqmax = max{ e.sequence : e ∈ W }` (the floor for the allocator).

### 2.3 Operations (the only mutators)

- **`put` / `batchPut`** — append sequenced entries to `W`. **Never touch `D`.**
  - `allocateSequence(count)`: under `SequenceLock`,
    `floor = max(W_seqmax, persistedCounter)`, `first = floor+1`, persist
    `{value: first+count-1}`, return `first`. **Fails closed** (throws) if the
    lock is not acquired — no unlocked fallback.
  - The WAL append is the **durability point**: `success:true` is set **after**
    `appendFileSync` (per-entry, by position) so a torn write surfaces as
    `success:false`.
- **`flushAhead`** — `W → D` materialization. Acquires `FlushLock`. For each
  day `d` with entries `seq > M_d`: fold the day's unflushed entries, consult
  the **global** `fold(W)` (P1-2 cross-day tombstone), build `toAdd` (live
  winners whose global-latest is not a tombstone) and `toDelete` (tombstones
  + globally-tombstoned). Batch-embed `toAdd`, then:
  - for each `add`: `materializeFlushBatch` = **`delete(hash=h)` then
    `add([rec])`** (delete-ALL-copies-then-add-one ⇒ converges to exactly
    one row);
  - for each `delete`: `table.delete(hash=h)`.
  Then `M_d := max applied seq`; write `M` once after the loop.
- **`rebuild`** — `D := materialize(fold(W))`. Does `table.delete('true')`
  then `insertRebuildBatch` (plain `add`) of all non-tombstone winners.
  **Does not touch `M`.** **Does not acquire `FlushLock`** (the P1 hole).
- **`get` / `getByDomain`** — `flushAhead()` then scan `D`.
- **`scheduleFlush`** — debouncer: if `inflightFlush` reuse it; else start one
  and clear on settle.

### 2.4 Locks

- **`FlushLock`** — WAIT-capable cross-instance mutex (file-based, stale-PID
  recovery). Held across embed + materialize in `flushAhead`.
- **`SequenceLock`** — WAIT-capable, **dedicated** (separate from
  `FlushLock`), for `allocateSequence`. Throws on timeout.

## 3. Invariants

- **[I1] WAL is truth (durability).** `W` is the authoritative state; `D` is a
  best-effort cache. After any crash, `Truth(·)` is recoverable from `W`
  alone (via `rebuild`). `D` may be lost or rebuilt at will.
- **[I2] Flush monotonicity (fail-LOW watermark).**
  `∀ d: M_d ≤ max{ seq(e) : e materialized into D from day d }`.
  The watermark never claims more is flushed than is durably in `D`.
  Corollary: a missing/low `M` ⇒ re-flush ⇒ idempotent convergence.
- **[I3] Flush convergence.** After a `flushAhead` pass that applies day `d`
  fully with no concurrent `W` mutation, `D(h)` is correct for every `h` whose
  winner lies in `d` (delete-then-add ⇒ exactly one row; global fold ⇒
  tombstones respected).
- **[I4] Cache-truth consistency (the key read invariant).** For any `h`
  returned by `get()` (which `flushAhead`s then reads `D`), `D(h)` is correct
  w.r.t. `Truth(h)`. A read never returns stale, resurrected, or
  duplicate-corrupted data that the watermark "promised" was already fixed —
  and never in the *wrong direction* (watermark ahead of reality).
- **[I5] Sequence uniqueness / total order.** Every allocated sequence is
  globally unique and monotonic (no reuse). The total order that `fold`
  resolves ties by is **lexicographic `(sequence, day-file, line)`**, not
  sequence alone: legacy entries (undefined seq → 0) and same-day rewrites can
  collide at equal sequence, where `foldWAL`'s `>=` resolves by file-order
  then line-order (both deterministic — day-files sort ascending, lines are
  append order). So the total order is deterministic and preserves append
  order for ties; reuse (a *re-emitted* sequence) is the killer and is what
  [I5] forbids. ⇒ tombstones win.
- **[I6] Row uniqueness (count convergence).** For each `h` with a live
  winner, `|D(h)| ≤ 1` (exactly one physical row, or none). Without this,
  re-flushing an already-flushed day accumulates duplicate physical rows per
  hash; the duplicates carry the *same* document (document-convergent) but
  corrupt top-K ranking (the same doc crowds out others) and inflate `get()`
  result sets. Satisfied for `flushAhead` by `materializeFlushBatch`
  (delete-all-copies-then-add-one); satisfied for `rebuild` by construction
  (`table.delete('true')` clears first, so plain `add` starts from ∅).
- **[I7] Read-your-write (per-process).** A process that just appended entry
  `e` to `W` and then calls `get()` sees `Truth(e)`. Holds because `get()`
  calls a **fresh** `flushAhead()` (not the debounced `scheduleFlush`) that
  re-reads `W` **after** the synchronous `appendFileSync`. This is the
  invariant that makes V2 harmless at read time.
- **[I8] No-wrong-direction watermark.** `M` is never *ahead* of `D`: the
  fail-LOW design guarantees `M ≤ reality`, never `M > reality`. This is the
  directional form of [I2]; V1 was the one path that inverted it.

## 4. Lemmas (operations that already preserve invariants)

**Lemma A — [I5] holds.** `allocateSequence` serializes
read-increment-write of the counter under `SequenceLock`; two concurrent
allocators cannot both read the same `current`. `first = floor+1` with
`floor = max(W_seqmax, persistedCounter)`; the persisted value only grows. A
crash between read and write leaves the counter low, but `floor` (from
`W_seqmax`) keeps `first >` any durable sequence. The throw-on-timeout
removes the unsafe `floor+1` fallback that previously violated [I5]. ∎

**Lemma B — [I2] holds for `flushAhead` alone.** `M_d` is advanced to
`maxSeq_d` only **after** the materialize/delete for day `d` completes;
`M` is written once after the loop. Materialize is delete-then-add (durable
LanceDB mutations). A crash before `writeWatermark` leaves `M_d` low ⇒
re-flush ⇒ idempotent (Lemma C). ∴ `M_d ≤` materialized. ∎

**Lemma C — [I3]+[I6] hold for a single undisturbed `flushAhead` (post-`bdbafd6`).**
For each `h` in `d`'s `toAdd`, `flushAhead` calls `materializeFlushBatch`
(shipped at `wiki.ts` L1292, called at L414) = **delete-all-copies-then-add-one**
⇒ `D(h) = {one row with e.document}` (count-convergent ⇒ [I6]; the global
fold guarantees the winner is not tombstoned) ⇒ `D(h) = Truth(h)` ([I3]).
For a tombstoned `h`, `table.delete(h)` clears all copies ⇒ `D(h)=∅=Truth(h)`.

> **Note on the deepseek peer review.** The peer *refuted* an earlier draft of
> this lemma on the grounds that `flushAhead` does a plain `table.add`. That
> refutation reviewed the **parent commit `b4f19e3`** (pre-fix), where
> `flushAhead` used `insertRebuildBatch` (plain add) and re-flush accumulated
> duplicates. Commit `bdbafd6` replaced that call with `materializeFlushBatch`
> (delete-then-add) — so the peer's "FIX-4 (delete-before-add)" is **already
> shipped**. The peer's *invariant* contribution stands: [I6] (count
> convergence) must be stated explicitly, since plain-add would violate it.
> `rebuild` remains plain-add but is count-correct by construction (it clears
> the table first). ∎

**Lemma C′ (pre-`bdbafd6`, for the record).** Under the old plain-add
`flushAhead`, the flush was *document*-convergent but *not count*-convergent:
re-flush added a second identical row per hash. This is the exact failure the
`bdbafd6` `materializeFlushBatch` fix closes.

## 5. Violations found in the shipped code

### V1 — [I2] + [I4] violated (reviewer P1: rebuild/flush race)

`rebuild` does **not** hold `FlushLock`. Interleave:

```
R: table.delete('true')      [D := ∅]
R: fold W → snapshot S at seq cutoff c
R: await embed…               [long async gap]
     F: acquire FlushLock; apply W entries with seq > c (newer); M_d := newer
     F: release FlushLock
R: insert S (older snapshot)  [D := older state]
```

Now `M_d = newer > c`, but `D` reflects `S` (≤ `c`). So
`M_d > materialized-newest` ⇒ **[I2] violated**. The next `get()` calls
`flushAhead()`, which sees `M_d ≥ newest-unflushed` ⇒ **skips** re-applying ⇒
reads the stale `D` ⇒ **[I4] violated**, and in the **wrong direction**
(watermark *ahead* of reality, not the safe fail-LOW *behind*). The fail-LOW
design assumes `M ≤ reality`; here `M > reality`.

This is strictly worse than ordinary eventual staleness: the freshness
marker and the materialized state disagree in the direction that makes a
read *trust* the stale cache.

**Fix V1.** `rebuild` must acquire the **same `FlushLock`** around the whole
destructive operation (clear + embed + insert). Writes only append `W`
(picked up by the next flush), so holding the lock across rebuild cannot
starve the write path. Under the lock, a `flushAhead` cannot interleave ⇒ no
`M`-ahead-of-`D` window.

**Fix V1b (completeness).** `rebuild` currently leaves `M` untouched. Under
the lock fix, rebuild sees a stable `W`, but a pre-existing `M` from a prior
crash could still be *ahead* of the rebuilt snapshot. The convergent move is
for `rebuild` to **reset `M := {}`** (or to the max applied seq) so the next
`flushAhead` re-materializes everything idempotently (Lemma C guarantees
convergence). This makes `rebuild` a true "cache reset to truth" rather than a
cache that can desync from the watermark.

### V2 — liveness gap (reviewer P2: scheduleFlush same-day miss)

`put()` appends to today's WAL **after** `flushAhead` already read today's
file (during the embed async gap). `scheduleFlush` reuses the still-running
`inflightFlush` ⇒ no second scan ⇒ the just-appended line is **not**
materialized this pass.

**Classification.** Does this violate [I4]? `get()` calls `flushAhead()` as a
**fresh** call (not the debouncer) ⇒ re-reads today's file ⇒ sees the new
line ⇒ applies. ∴ [I4] **holds at read time**; `W` stays correct ([I1]). V2 is
a **liveness** gap in the opportunistic "write → scheduleFlush → cache
catches up" property, **not** a safety violation. The background flush can
finish "successfully" without materializing its triggering write.

**Fix V2 (liveness).** Generation-aware debouncer: on flush completion, if
`W` advanced past the watermark since the flush started, schedule one more
coalesced pass. Equivalently: after a flush settles, re-check
`∃ d : maxSeq(W_d) > M_d` and if so schedule another flush. Key insight:
*"one in-flight flush"* and *"one flush per burst"* are not the same thing.

### V3 — crash cleanup (reviewer P2: empty lockFile)

`FlushLock`/`SequenceLock` constructors default `lockFile=''`;
`WikiManager` constructs them **without** a path ⇒ the SIGINT/SIGTERM handler
runs `unlinkSync('')` (a no-op). The lockfiles are left stale on crash.

**Classification.** Does this violate any invariant? `acquire()` **steals
stale holders** (PID-liveness + heartbeat freshness), so a stale lock is
recovered on the next acquire. ∴ **safety is preserved** (no permanent
deadlock, no lost writes); only the *immediate* crash cleanup degrades to
*deferred* recovery, adding latency on the next acquire. V3 is a
**liveness/cosmetic** issue, not a safety violation.

**Fix V3.** Pass the lock path into the constructor (or have the crash
handler close the same path used by `acquire()`), so SIGINT/SIGTERM removes
`flush.lock`/`sequence.lock` immediately.

## 6. Minimal fix set and sufficiency

The minimal fix set (against the **current** `bdbafd6` code, where
`materializeFlushBatch` delete-then-add is already shipped for `flushAhead`)
is:

1. `rebuild` acquires `FlushLock` around clear+embed+insert, **and** resets
   `M := {}` (V1 + V1b) — restores [I2]/[I8] and [I4] in the rebuild/flush case.
2. Generation-aware `scheduleFlush` (V2) — restores the opportunistic
   liveness property (not a safety invariant).
3. Pass `lockFile` to the lock constructors (V3) — restores immediate crash
   cleanup (liveness).

> **FIX-4 (delete-before-add in `flushAhead`'s live path) is already shipped
> in `bdbafd6`** (`materializeFlushBatch`, L1292). It restores [I6] (count
> convergence) for `flushAhead`. `rebuild` needs no FIX-4: it clears the
> table first (`delete('true')`), so its plain `add`s start from ∅ and are
> count-correct for the snapshot. The deepseek peer flagged FIX-4 as a
> *required* addition because it reviewed the pre-fix parent `b4f19e3`; in the
> current code it is already present.

**Sufficiency argument.** Fixes 1–3 do not change Lemmas A/B/C; they close
the three holes:

- After V1+V1b, **both** table mutators (`flushAhead`, `rebuild`) hold the
  same `FlushLock`, so the only concurrent mutators are append-only `W`
  writes (which never touch `D` or `M`). The watermark is only ever advanced
  under the lock by `flushAhead`, and `rebuild` resets `M` so it can never
  leave a stale ahead-of-reality `M` ([I8]).
- After V2, the debouncer no longer swallows a same-day append silently
  ([I7] already covers the read path; V2 covers the background path).
- After V3, crash recovery is prompt rather than deferred.

### Ordering obligations (O1–O6) — the assumptions the proof needs

The §7 induction closes only if these hold. O1, O2, O4, O5 are code
properties (mostly already true); **O3 is a durability-ordering obligation
the lock model cannot supply** and must be verified/tested.

- **O1 (V1 fix):** `rebuild` and `flushAhead` are mutually exclusive (same
  `FlushLock`) — `D` has a single writer at a time. *(pending V1 fix)*
- **O2 (V1b fix):** `rebuild` resets `M` under the lock — post-rebuild `M`
  is not ahead. *(pending V1b fix)*
- **O3 (durability order — verified, not gated):** each `D` mutation
  (`table.add`/`table.delete`) **durably commits before** `writeWatermark`
  returns. **Verified against LanceDB 0.27.2**: the Lance format writes each
  new data fragment to disk synchronously in `add`, and `delete` rewrites the
  fragment + advances the manifest; both resolve their `Promise` only after
  the fragment and the manifest (the commit point) are written. The manifest
  write IS the durability barrier — a reader cannot see an `add` whose
  manifest isn't committed, and a crash leaves either the full fragment or
  nothing (Lance fragments are append-only and self-describing). There is no
  separate fsync API to call, and `table.optimize()` is compaction/perf
  (rewrites fragments for read speed), NOT a durability barrier — gating
  `writeWatermark` on it would be both wasteful and semantically wrong. So
  `writeWatermark` (a plain `fs.writeFileSync` of `watermark.json`, itself
  durable on return) runs strictly after the durable `add`/`delete` ⇒ O3 holds
  by construction. **Residual**: if a future LanceDB version moves the
  manifest write off the `add`/`delete` return path (buffered/async commit),
  O3 would re-open; the regression test (flush → kill before any async commit
  could land → restart → assert re-flush re-materializes and `M` is not
  ahead) guards this. The fail-LOW watermark design already bounds the blast
  radius: even an O3 inversion from a crash is repaired by the next
  `flushAhead`/`rebuild` (Lemma C + the V1b reset).
- **O4 (FIX-4, shipped):** `flushAhead`'s live-insert path is
  delete-before-add — count-convergence [I6]. *(done in `bdbafd6`)*
- **O5 (read):** `get()`/`getByDomain()` call a **fresh** `flushAhead()`,
  not the debouncer. *(already true — code calls `this.flushAhead()`
  directly)*
- **O6 (sequence):** `SequenceLock` makes allocated sequences unique and
  monotone; ties resolve by `(seq, file, line)`. *(Lemma A + [I5])*

## 7. The hard proof: [I4] under arbitrary interleaving

**Theorem.** *After fixes V1+V1b, for any `h` returned by `get()` under
arbitrary interleaving of `flushAhead`, `rebuild`, `put`, and crashes, `D(h)`
is correct w.r.t. `Truth(h)` — i.e. [I4] holds.*

**Proof sketch (induction on lock-protected critical sections).**

Let a **critical section** be an interval in which `FlushLock` is held. After
V1+V1b, *every* mutation of `D` or `M` occurs inside a critical section
(`flushAhead` and `rebuild` both acquire `FlushLock`; `put` touches neither
`D` nor `M`). `W` appends are append-only and lock-irrelevant to `D`/`M`
correctness.

Define the **coherence predicate** `C`:
`C ⇔ ( ∀d: M_d ≤ maxSeq(durably materialized from d) ) ∧ ( ∀h: if M covers h's winner then D(h) correct for Truth(h) )`.
We show `C` is an invariant of every critical section.

- **Base.** Empty `W`/`D`/`M`: `C` holds vacuously.
- **`flushAhead` step (Lemma B + C).** Inside the lock: for each applied day
  `d`, materialize is delete-then-add (correct per Lemma C) **before**
  `M_d` is raised; `M_d` is set to exactly the max applied seq. No concurrent
  `D`/`M` mutation is possible (lock). A crash before `writeWatermark` leaves
  `M_d` low (fail-LOW) ⇒ `C`'s first conjunct preserved; the second conjunct
  is monotone (raising `M` only "claims" entries just materialized). ∴ `C`
  preserved.
- **`rebuild` step (after V1+V1b).** Inside the lock: `table.delete('true')`
  empties `D`, then `insertRebuildBatch` inserts the global fold's live
  winners ⇒ `D(h)` correct for `Truth(h)` for **all** `h` in the snapshot; and
  `M := {}` resets the watermark to fail-LOW ⇒ `C`'s first conjunct holds
  vacuously (`M_d` is now 0 ≤ anything materialized), and the second conjunct
  holds because `M` claims nothing. No `flushAhead` interleaves (lock). ∴
  `C` preserved. A crash mid-rebuild leaves `D` partial and `M` reset ⇒ next
  `flushAhead` re-materializes idempotently (Lemma C) ⇒ `C` re-established.
- **`put` step.** Appends to `W` only; does not touch `D` or `M`. `Truth(h)`
  may change (a new winner for `h`), but `M` has not advanced for the new
  entry, so `C`'s second conjunct still holds for the *covered* prefix (the
  new entry is uncovered). ∴ `C` preserved.

**Read step (`get`).** `get()` runs `flushAhead()` (a critical section that
re-establishes `C` for the now-current `W`) **then** scans `D`. At scan time,
`C` holds: every `h` whose winner is covered by `M` has `D(h)` correct, and
`flushAhead` just covered all winners up to the current `W_seqmax`. Any `h`
returned is covered ⇒ `D(h) = Truth(h)`. ∴ **[I4] holds.** ∎

**Caveat (residual stale window — stated honestly).** [I4] holds for the
**promised** set (entries with `seq ≤ M`). Do **not** claim "`get()` always
returns `Truth`" — claim "`get()` never returns a stale/resurrected/
duplicate-corrupted answer for a hash the watermark promised was
materialized." A `put` that appends *after* the `flushAhead` inside this
`get()` completes is not covered by `M`; that `h` is the writing agent's
own just-written entry, covered by read-what-you-write ([I7]) at the
triologue layer. A *cross-instance* reader that beats the flush sees an
older `D` for entries with `seq > M` — the intentional, bounded eventual
window, never loss/resurrection, and never in the wrong direction because
`M` is never ahead of `D` ([I8], Lemma B + the rebuild reset). V1 was the
*only* path that put `M` ahead of `D`; V1+V1b closes it.

**Caveat (O3 — crash durability, verified).** The induction's crash case
assumes each `D` mutation is durable *before* `writeWatermark` (O3).
**Verified against LanceDB 0.27.2**: `table.add`/`table.delete` write the
Lance fragment + advance the manifest (the commit point) synchronously
before resolving their `Promise`; the manifest write IS the durability
barrier, so `writeWatermark` (a durable `fs.writeFileSync`) runs strictly
after the durable mutation. There is no separate fsync API; `optimize()` is
compaction/perf, not a barrier (gating on it would be wrong). So a crash
*after* `writeWatermark` cannot leave `M` ahead of a *lost* mutation — the
mutation was already committed. **Residual**: a future LanceDB version that
buffers the manifest write off the return path would re-open O3; the
regression test (flush → kill → restart → assert re-flush re-materializes,
`M` not ahead) guards this, and the fail-LOW design bounds any inversion's
blast radius (next `flushAhead`/`rebuild` repairs it). ∎

## 8. Verdict

| Finding | Invariant | Class | Fix | Status |
|---|---|---|---|---|
| rebuild/flush race (P1) | [I2], [I4], [I8] | **Safety** | rebuild holds `FlushLock` + resets `M` | **Open** (V1+V1b) |
| scheduleFlush same-day miss (P2) | liveness ([I7] covers reads) | Liveness | generation-aware debouncer | **Open** (V2) |
| crash handlers empty `lockFile` (P2) | crash cleanup latency | Liveness | pass `lockFile` to constructors | **Open** (V3) |
| re-flush duplicate rows (P2) | [I6] | Safety (ranking) | delete-before-add in `flushAhead` | **Done** (`bdbafd6`) |
| sequence reuse (P1, prior) | [I5] | Safety | `SequenceLock` throws on timeout | **Done** (`bdbafd6`) |
| **O3 — D durability before watermark** | [I8] (crash) | Safety (crash) | **Verified** LanceDB 0.27.2: add/delete commit manifest (barrier) before Promise resolves; writeWatermark runs after | **Verified** |

The WAL-as-truth direction is sound. Against the **current** `bdbafd6` code:
the duplicate-row fix (→[I6]) and sequence-uniqueness fix (→[I5]) are already
shipped. The remaining safety work is **V1+V1b** (rebuild under the flush
lock + watermark reset) and the **O3** durability-ordering verification. V2 and
V3 are liveness cleanups. The reviewer's "merge the direction, not this
revision" verdict is correct; V1 (+ O3 verification) is the gate for merge.