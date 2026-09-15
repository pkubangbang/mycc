# Todo Previous-Hash Lineage Ring — Design Doc

> Tells the story behind the change that added a per-item ring of previous
> integrity hashes to the todo module, so a stale-hash `todo_update` rejection
> can be enriched with a **warm hint** carrying the *current* hash — without
> ever accepting the stale write.

## TL;DR

Every `TodoItem` now carries `previousHashes?: string[]` (cap 3, oldest
dropped first). When `updateTodo` or `closeCheckpointTodo` recomputes the
integrity hash, the OLD hash is pushed into that ring first. When
`todo_update` rejects a write on a hash mismatch, it calls
`findByPreviousHash(staleHash)`: if the stale hash is found in some live
item's lineage ring, the error message includes the item's *current* hash so
the LLM can retry this same turn. If the stale hash is not in any ring, the
error is exactly today's generic mismatch message (silent otherwise). The
stale write is **always rejected** — the ring is read-only observation
metadata, never a second-chance update path.

---

## 1. The bug this solves

### 1.1 Where stale hashes come from

`TodoItem.hash = SHA256(name|done|note)[:8]`. The hash is the anti-hallusion
gate for `todo_update` / `pinTodo`: the LLM must present the hash it last saw
in `printTodoList`, and the write is rejected if it doesn't match the stored
hash. So far so good — *as long as the hash is stable between the LLM reading
it and the LLM using it.*

It isn't always stable. The trigger that surfaced this was the
cross-machine peer wire's info-symmetry reminder todo. `ParentContext`
registers a `recordRemotePeerTodo` wire hook
(`src/context/parent-context.ts`) that maintains one **pinned** todo per
remote peer pair, deduped by endpoint:

```ts
const openName  = `remote peer ${sid} at ${endpoint} — wire, mail_to("${sid}/lead")`;
const doneName  = `remote peer ${sid} at ${endpoint} — wire disconnected (re-run peer_connect to reconnect)`;
```

The remote peer's **session id is embedded in the todo name**. Two wire-driven
events recompute the hash out from under the LLM:

1. **Remote restart** — the remote mycc comes back with a *new* session id.
   The next announce frame fires `recordRemotePeerTodo({ sid: newSid, …,
   done: false })`, which calls
   `updateTodo(existing.id, existing.hash, openName-with-newSid, false, …)`.
   The name changed → the hash changed.
2. **open ↔ disconnected flip** — teardown fires `done: true` with
   `doneName`, re-establishment fires `done: false` with `openName` again.
   `done` changed → the hash changed.

`recordRemotePeerTodo` keeps its own cached `{ id, hash }` in
`wireRemoteTodoIds` and updates it on every successful write, so the *wire
plane's* own subsequent writes keep working. The problem is the **LLM**: it
captured a hash from the last `printTodoList` (rendered into the prompt), and
that captured hash is now stale. Its next `todo_update(id, staleHash, …)`
returns `null`, and the tool replies:

> Error: Hash mismatch for todo #N. The item may have been updated since you
> last read it. Check the current todo list for the latest hash.

That is correct (the write *should* be rejected), but it gives the LLM **no
way to recover this turn** — the message doesn't tell it the current hash, so
it must wait for the nudge cycle to re-render `printTodoList`.

### 1.2 Why the nudge self-heal wasn't enough

The todo nudge reprints `printTodoList` (with fresh hashes) every 3 COLLECT
passes. So the staleness is *self-healing* — eventually the LLM sees the
current hash and retries successfully. That is why the first reaction to this
bug was "leave it, the nudge fixes it." But "eventually" has a cost:

- **A transient dead window.** Between the wire event that invalidated the
  hash and the next nudge, any `todo_update` the LLM issues against that item
  fails. For a *pinned* remote-peer reminder that the LLM isn't actively
  editing, this is benign. For a todo the LLM is actively working on (e.g. a
  remote restart that happens mid-task), the failed update costs a turn and
  can mislead the LLM into thinking the item was deleted.
- **The error is unhelpful.** "Check the current todo list" forces a
  round-trip through the prompt; the system *knows* the current hash but
  withholds it.

The fix's goal is narrow: **close the dead window for the common case**
(stale hash is a recent previous hash of a live item) by handing the LLM the
current hash *in the rejection itself*, while changing nothing else about the
integrity gate.

---

## 2. Alternatives considered and rejected

### 2.1 Move `note` out of the hash signature (REJECTED)

The peer reminder puts the volatile `sid` in the *name*, but other callers
(e.g. checkpoint todos) put volatile data in the *note*. A tempting
generalization: drop `note` from `SHA256(name|done|note)` so note changes
don't invalidate the hash.

Rejected because the blast radius is huge and the benefit is incidental:

- Every existing test that asserts "different note → different hash" breaks.
- The hash would no longer cover `note`, weakening the integrity signature
  for *all* todos to paper over one caller's volatility.
- The real volatility is the **sid in the name**, not the note — so this
  wouldn't even fix the peer-reminder case without also moving the sid out of
  the name, which defeats the reminder's whole "tell the LLM the sid to
  `mail_to`" purpose.

The user explicitly bailed this direction: the nudge self-corrects, and a
targeted hint is a smaller, safer change.

### 2.2 Make `recordRemotePeerTodo` not embed the sid (REJECTED)

The sid in the name is *load-bearing*: the todo text is the LLM's cue for the
exact `mail_to("<sid>/lead")` routing string. Removing it breaks the
reminder's job.

### 2.3 A second-chance update path (REJECTED)

"If the stale hash is in the lineage ring, just apply the write anyway."
Rejected unconditionally — that collapses the anti-hallusion gate. The ring
is **observation-only**: it exists to produce a better error message, not to
accept stale writes. The integrity check in `updateTodo` is untouched.

---

## 3. The chosen design

### 3.1 Data model

`TodoItem` gains one optional field (`src/types.ts`):

```ts
/**
 * Lineage ring of previous integrity hashes (cap 3, oldest dropped first).
 * Read-only metadata: every time a field in the hash signature (name|done|note)
 * changes and the hash is recomputed, the OLD hash is pushed here before the
 * new one is assigned … The stale WRITE is still rejected; the ring only
 * enables a better error message. `pinTodo` does NOT recompute the hash, so
 * it never pushes here.
 */
previousHashes?: string[];
```

`TodoModule` gains one lookup method:

```ts
findByPreviousHash(hash: string): TodoItem | null;
```

### 3.2 When the ring is written

A module-private helper `pushPreviousHash(item, newHash)` does the work
(`src/context/shared/todo.ts`):

```ts
const LINEAGE_RING_CAP = 3;

function pushPreviousHash(item: TodoItem, newHash: string): void {
  if (newHash === item.hash) return;          // no-op transition
  const ring = item.previousHashes ?? [];
  ring.push(item.hash);                        // push the OLD hash
  while (ring.length > LINEAGE_RING_CAP) ring.shift();
  item.previousHashes = ring;
}
```

It is called from exactly two places — every site that recomputes the hash:

1. **`updateTodo`** — after assigning the new `name`/`done`/`note`, compute
   `newHash`, push the old hash, then assign `existing.hash = newHash`.
2. **`closeCheckpointTodo`** — same pattern (the `done` flip changes the
   hash, so the old hash is recorded first).

It is **NOT** called from `pinTodo`, because `pinTodo` does not recompute the
hash (`pinned`/`reactivate` are not part of the signature). This is the key
invariant that keeps the ring honest: **the ring only ever holds hashes the
item actually transitioned through.**

### 3.3 When the ring is read — the warm hint

In `todo_update`'s mismatch branch (`src/tools/todo_update.ts`), after the
not-found check, the tool attempts a lineage lookup **only on the rejection
path** (the write has already been refused):

```ts
const lineageMatch = ctx.todo.findByPreviousHash(hash.trim());
if (lineageMatch) {
  return `Error: Hash mismatch for todo #${id}. This item was updated since you last saw it — the current hash is ${lineageMatch.hash}. Retry todo_update with the current hash.`;
}
return `Error: Hash mismatch for todo #${id}. The item may have been updated since you last read it. Check the current todo list for the latest hash.`;
```

Behavior, per the user's constraint:

- **Only hint on a match.** If the stale hash resolves to a live item's
  lineage, the error carries the *current* hash — the LLM can retry this same
  turn, no nudge wait.
- **Silent otherwise.** If the stale hash is not in any ring (e.g. it was
  evicted by the cap, or it was never a hash of a live item), the error is
  byte-for-byte today's generic mismatch message. No new failure modes.
- **The write is still rejected.** `updateTodo` returned `null` before this
  branch runs; the lookup never applies the stale write. The integrity gate
  is unchanged.

### 3.4 Why cap 3

The ring bounds memory and lookup cost. A cap of 3 covers the realistic
staleness window: the LLM holds at most one or two stale hashes (from the
last one or two `printTodoList` renders), and the wire plane can re-key a
peer todo a few times during a flappy reconnect. Three slots is enough to
catch the common case while keeping `findByPreviousHash` (a linear scan over
`items × ring`) trivially cheap. Older hashes age out — if the LLM is more
than 3 hash-generations behind, it falls back to the nudge, which is the
pre-fix behavior anyway.

---

## 4. Data flow

```
 wire event (remote restart / open↔disconnected)
   │
   ▼
 recordRemotePeerTodo({ sid, endpoint, done })
   │   existing = wireRemoteTodoIds.get(endpoint)
   │   updateTodo(existing.id, existing.hash, newName, done, …)
   ▼
 Todo.updateTodo
   │   gate: existing.hash !== hash?  → no (wire plane's cached hash is fresh)
   │   newHash = computeHash(name, done, note)        ← name changed (new sid)
   │   pushPreviousHash(existing, newHash)            ← OLD hash → ring[0]
   │   existing.hash = newHash
   │   wireRemoteTodoIds.set(endpoint, {id, hash: newHash})   ← wire plane updated
   ▼
 …later, the LLM (holding the hash from the PREVIOUS printTodoList)…
   │
   ▼
 todo_update(id, STALE_hash, …)
   │
   ▼
 Todo.updateTodo → gate: existing.hash !== STALE_hash  → return null   ← WRITE REJECTED
   │
   ▼
 todo_update mismatch branch
   │   exists? yes
   │   lineageMatch = findByPreviousHash(STALE_hash)
   │      └─ items.find(i => i.previousHashes?.includes(STALE_hash))  → hit (ring[0])
   │   return "… the current hash is <newHash>. Retry todo_update with the current hash."
   ▼
 LLM retries todo_update(id, newHash, …)  → SUCCESS (same turn, no nudge wait)
```

---

## 5. Bugs hit during implementation (and what they taught)

Two bugs appeared while writing the tests; both are worth recording because
they are easy to reintroduce.

### 5.1 The "push before assign" guard that always short-circuited

The first version of `pushPreviousHash(item, oldHash)` had a guard against
no-op transitions:

```ts
// WRONG
function pushPreviousHash(item: TodoItem, oldHash: string): void {
  if (oldHash === item.hash) return;   // ← always true at the call site!
  ring.push(oldHash);
  ...
}
```

It was called *before* `existing.hash` was reassigned, so `oldHash` was
`existing.hash` — the guard was *always* true and nothing was ever pushed.
`findByPreviousHash` and the `closeCheckpointTodo` ring test both got
`undefined` for `previousHashes`.

**Fix:** change the contract to "call after computing the new hash, pass the
new hash in, push `item.hash` (the old one), guard on `newHash === item.hash`."
The guard now correctly skips only genuine no-ops (an `updateTodo` with
identical `name|done|note`), and the push reads the old hash from `item.hash`
before the caller reassigns it. Lesson: **a guard that compares a parameter to
the live field is a hazard when the call site hasn't updated the field yet** —
pass the *new* value in and compare against the live (old) one.

### 5.2 `updateTodo` auto-clear vs. single-item tests

Several lineage tests flipped the *only* non-pinned todo to `done: true`.
`updateTodo` auto-clears all non-pinned items once every non-pinned item is
done — so the item under test was dropped from `this.items`, and
`getItems().find(…)` returned `undefined`. The test then crashed reading
`.hash` off `undefined`, which looked like an implementation bug but was a
test-setup bug.

**Fix:** each affected test creates a companion open non-pinned todo so the
target survives the `done` flip, and the cap test uses name-only changes
(never flips `done`) so the item is never a candidate for auto-clear. Lesson:
**when testing `updateTodo`'s side effects, account for auto-clear** — it
fires on the same call that recomputes the hash, so it can remove the very
item you're inspecting.

---

## 6. What did NOT change

- **`computeHash`** — still `SHA256(name|done|note)[:8]`. `note` is still in
  the signature.
- **The integrity gate** — `updateTodo` still returns `null` on a hash
  mismatch. The lineage ring never feeds back into the gate.
- **`pinTodo`** — still does not recompute the hash, so it does not touch the
  ring.
- **`printTodoList`** — unchanged; `previousHashes` is not rendered (it's
  internal metadata).
- **The auto-clear rule** — unchanged.
- **The nudge cycle** — unchanged; it still re-surfaces fresh hashes. The
  warm hint just makes the common case not *need* to wait for it.

---

## 7. Verification

All four gates green after the change:

| Gate | Command | Result |
|------|---------|--------|
| Source type-check | `npx tsc --noEmit` | pass |
| Test type-check   | `npx tsc --noEmit -p tsconfig.test.json` | pass |
| Targeted tests    | `npx vitest run src/tests/context/shared/todo.test.ts src/tests/tools/todo-update.test.ts src/tests/tools/todo-create.test.ts` | 67/67 pass |
| Lint              | `pnpm lint` (eslint src/) | pass |

New/changed tests:

- `todo.test.ts` — 7 new lineage tests: ring push on `updateTodo`, cap-3
  eviction, `findByPreviousHash` resolves to the current item, returns null
  on no match, no-op update doesn't push, stale write still rejected on a
  lineage match, `closeCheckpointTodo` pushes the old hash.
- `todo-update.test.ts` — 2 new tests: warm hint with current hash on a
  lineage match (write still rejected); silent generic mismatch when the
  stale hash is not in any ring. Existing "hash mismatch" test preserved
  verbatim (mock's `findByPreviousHash` defaults to `null`).
- Mocks (`mock-context.ts`, `todo-create.test.ts`, `todo-update.test.ts`) —
  `findByPreviousHash: vi.fn(() => null)` added so the extended `TodoModule`
  type-checks; default `null` preserves today's exact mismatch message.

---

## 8. Files touched

| File | Change |
|------|--------|
| `src/types.ts` | `previousHashes?: string[]` on `TodoItem`; `findByPreviousHash` on `TodoModule`. |
| `src/context/shared/todo.ts` | `LINEAGE_RING_CAP`, `pushPreviousHash` helper; ring push in `updateTodo` + `closeCheckpointTodo`; `findByPreviousHash` method. |
| `src/tools/todo_update.ts` | Mismatch branch calls `findByPreviousHash`; warm hint on match, generic message otherwise. |
| `src/tests/context/shared/todo.test.ts` | 7 lineage tests. |
| `src/tests/tools/todo-update.test.ts` | 2 warm-hint tests; mock gains `findByPreviousHash`. |
| `src/tests/tools/todo-create.test.ts` | Mock gains `findByPreviousHash`. |
| `src/tests/test-utils/mock-context.ts` | `createMockTodo` gains `findByPreviousHash` (default `null`). |

---

## 9. Cross-references

- `docs/todo-module-redesign.md` — the hash integrity gate this builds on.
- `docs/pinned-todo-reactivation.md` — pinned todos & the nudge cycle (the
  self-heal path the warm hint complements).
- `docs/remote-peer-protocol.md` §2 step 3 — the `recordRemotePeerTodo`
  info-symmetry reminder whose sid-in-name volatility surfaced this bug.
- `src/context/parent-context.ts` — `recordRemotePeerTodo` wire hook.