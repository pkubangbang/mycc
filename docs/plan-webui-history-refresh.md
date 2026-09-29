# Plan: WebUI history refresh — make the triologue transcript the single source of truth for user bubbles

Status: agreed (plan mode exited). Target: `src/serve/serve-history.ts`, `src/loop/triologue*`,
`src/loop/states/prompt.ts`, `src/loop/agent-repl.ts`, docs + tests.

## Problem (verified against real session data)

`GET /history` rebuilds the chat log from three sources:

| Source | Holds | Written by |
|---|---|---|
| transcript JSONL | assistant/tool/system + genuine user (`user_origin:true`, `kind:'new'`) | always (terminal + serve) |
| `user.jsonl` | prompt queries + steering notes | **only while serve runs** (`prompt.ts` guards `appendUserLog` behind `hub.isRunning()`) |
| in-RAM `messageLog` | brief/log/warn/error + cards | serve only |

`readHistory()` skips every `role:'user'` transcript record (anti-pollution: that role also holds
injected `[REMINDER]`/`[HINT]`/`[WRAP_UP]` notes), so a query typed in **terminal mode** — or before
serve started — is dropped on refresh even though the always-written transcript already holds it.

Second, harder finding: when `lastRole === 'user'`, `triologue.user()` **merges** the new fragment into
the host and emitted `{ kind:'merge', userOrigin:false }` — a genuine query became indistinguishable
from an injected note (live evidence: session `849a9dd2`, line 96).

## Fix (six sections)

### 1. Transcript vocabulary — `src/loop/triologue/transcript.ts`
Two message-bearing journal kinds join `PieceKind`:

```
{ role:'user', content, kind:'user',  user_origin:true, timestamp }  // folded genuine input fragment
{ role:'user', content, kind:'steer', user_origin:true, timestamp }  // user-typed steering note
```

- `readTranscript` accepts them and validates (`role==='user'` and `user_origin===true`, else skip into `skippedLines`).
- `collateMessages` (restoration): `'user'` folds into the last collated user host (livelog parity); `'steer'` skipped.
- `collateEntries` (serve): `'user'`/`'steer'` pushed as their own entries; `'merge'` skipped;
  `'new'` + `role:'user'` + marker pushed; `'new'` + `role:'user'` without marker skipped; other roles pushed;
  boundary kinds skipped without cutting the view.

### 2. Producers
- `triologue.ts`: `emit()` kind widened to `PieceKind`; `user()` combine branch emits `kind:'user'` + marker;
  new `submitUser(text, source='prompt')` emits only the journal record (never touches store/ledger/lastUserQuery).
- `triologue-lite.ts`: mirrored.
- `serve-hub.ts`: `setUserJournalProvider(cb)` seam (same shape as `setEnterAutoProvider`); `pushSteer` calls it
  instead of `appendUserLog` — so a steering note is journaled at **submission** time.
- `agent-repl.ts`: register the provider beside `setTranscriptPath`.
- `prompt.ts`: delete the `appendUserLog` block (the query is journaled by `triologue.user()` itself).

### 3. Reader — `src/serve/serve-history.ts`
- Delete `readUserLog` and the `userLogPath` parameter → `readHistory(transcriptPath, messageLog)`.
- Replace the `timestamp <= 0` drop with an emission-order normalisation (entries with no timestamp inherit the
  last known positive timestamp; an all-legacy file keeps exact file order). Closes pitfall `8547e85b`.
- Rewrite the header doc-block: one durable source.

### 4. Delete `user.jsonl`
- `serve-hub.ts`: remove `userLogPath`, `setUserLogPath`, `appendUserLog` + the two `/history` call sites.
- `computeHistoryVersion(transcriptPath, messageLog, steeringLength, isRunning)` — user-log stat slot dropped
  (a steering journal still flips the ETag by growing the transcript file).
- `agent-repl.ts:102` `setUserLogPath(...)` dropped; stale comment in `serve-clients.ts:131` rewritten.
- Docs: `src/web/README.md` (`:166`, `:229`, `:331-336`), `docs/session-file-reorganization-design.md:124-156`.
- Existing on-disk `user.jsonl` files stay as inert archives.

### 5. Tests
- `transcript.test.ts`: new-kind round-trip + validation; `collateEntries` new expectations; `collateMessages` fold test.
- `triologue.test.ts`: combine → `kind:'user'` + marker; `Captured` kind union; `submitUser` emits one `'steer'` piece.
- `triologue-lite.test.ts`: kind lists widened at `:400`, `:416`.
- `serve-history.test.ts`: drop the `readUserLog` suite; new source cases; timestamp-normalisation case.
- `serve-history-version.test.ts`: new signature.
- `prompt-autofly.test.ts:101` / `prompt-upload-rollback.test.ts:89`: drop the `appendUserLog` stub.
- `mock-harness.ts:193-216`: add `submitUser` to the Triologue stub.
- New regression fixture from session `849a9dd2` (9 genuine queries incl. the unmarked line-96 merge) → 9 bubbles.

### 6. Verification
`pnpm vitest run src/tests/loop src/tests/serve src/tests/session` → `npx tsc --noEmit` + eslint →
manual e2e (two terminal-mode queries → `/serve` → reload → both bubbles) → live `curl http://localhost:3173/history`.

## Ordering / interaction notes

- Sections 1–3 must land **together**: 1 defines the vocabulary, 2 writes it, 3 reads it. A partial landing renders nothing.
- Section 3 and 4 change the same signatures (`readHistory`, `computeHistoryVersion`) — same commit.
- The transcript keeps a **single writer** (`JsonlTranscriptWriter`, which owns `kind` stamping and the write-time
  timestamp); the hub reaches it only through the provider seam. Never let the hub append to the transcript directly.
- The two collation projections must stay separate: the serve view is a clean scan (notes skipped), the restoration
  view must still fold `'user'` to reproduce the livelog (pitfall `11f10ae7`: collate-view ≡ livelog holds only if
  every livelog mutation is replayed).
- `user_origin` is retained as the "typed by a human" attribute, now also set on `'steer'`.
- One UX change accepted: PROMPT-time steering synthesis produces both the typed-note bubbles and the synthesised
  query bubble (both were real livelog mutations).
