# Peer Topology — declarative peer groups (`mycc-compose`)

> Status: **implemented** (§1–§5). The `mycc-compose` CLI, the `--session-id`
> pinning + args-publishing enabling changes, and the `mycc-compose` /
> `mediator` skills are landed. This document remains the single source of
> truth for the design. §9 (GUI) is deferred.

## 1. Problem

Bringing up a group of peer mycc instances today is an imperative, manual
procedure: launch each instance, read its session-id out of
`~/.mycc-store/discovery/identity.json`, wait for heartbeats to go fresh, then
hand-author a **pair** of channel files (`<sidA>-<channelId>.json` and
`<sidB>-<channelId>.json`) whose `firstQuery` carries the mail-`to` reply
contract. `src/peer/channel.ts` states channel-file authoring is explicitly
**out of scope** — "a mediator (script, mycc instance, or human operator)" owns
it. Nothing in the codebase writes a channel file.

Consequences:

- **Not reproducible.** The group lives only in a transcript.
- **Not resumable.** Session ids are ephemeral `randomUUID()` per session
  (`writeFreshSessionFiles()` hardcodes `randomUUID()`; `createSessionFile`
  accepts an id but no caller passes one). Channel files are keyed on
  `<sessionId>-<channelId>.json` and `listChannels()` only sweeps files
  prefixed with the *current* session id, so a restarted instance can never
  re-join a prior channel. `--from <id>` branches a **new** session; it does
  not reopen the old one.

## 2. Goal

A **declarative spec** (JSON) describes a peer group — members, how to launch
them, and which channels connect them — and a **deterministic CLI**
(`mycc-compose`) materializes it: launch/renew members, mint or reuse their
session ids, write both channel files per link, and report status. Re-running
the tool is the resume path (cron / `--daemon <skill>` + `service_cron`). No
LLM is in the loop; the script is the entire mechanism.

## 3. Spec schema (v2)

```json
{
  "group": "pr26",
  "peers": [
    { "name": "leader",   "workdir": "C:/Proj/mycc",
      "args": "--auto --skip-healthcheck --ollama-model glm-5:cloud",
      "sessionId": null, "renew": "onMismatch" },
    { "name": "reviewer", "workdir": "C:/Proj/mycc",
      "args": "--auto --skip-healthcheck --ollama-model deepseek-v4.1-flash:cloud",
      "sessionId": null, "renew": "onMismatch" }
  ],
  "channels": [
    { "from": "leader", "to": "reviewer", "label": "review",
      "prompt": "Peer is {{to}}. Reply via mail_to(name=\"{{to}}/lead\", title=\"{{label}}:<subject>\"). No prose replies." }
  ]
}
```

### Fields

| Field | Type | Notes |
|---|---|---|
| `group` | string | Label only. Used as the channel-title prefix. **Never** part of a session id. |
| `peers[].name` | string | Label only; the key referenced by `channels[].from` / `.to`. Never part of a session id. |
| `peers[].workdir` | string | Absolute path; the peer is launched with this as cwd. |
| `peers[].args` | string | **Single whitespace-split string** of CLI flags (model rides here; there is no `model` field). Must include `--auto` or `--daemon` (see §6.3). |
| `peers[].sessionId` | string \| null | `null` on first `up` → the tool mints a UUID and **writes it back in place**. No sidecar file. |
| `peers[].renew` | `"always"` \| `"onMismatch"` | Default `onMismatch`. See §6.2. |
| `channels[].from` / `.to` | string | `peers[].name` values. Directed; the tool completes the mirror pair. |
| `channels[].label` | string | Becomes the channel **`channelId`** and the filename suffix. Must be safe as a filename *component*: the tool rejects `/`, `\`, `..`, control characters, and the Windows-reserved set `: * ? " < > |` (a label like `x/../../identity` would otherwise escape the channels directory and overwrite `identity.json`). |
| `channels[].prompt` | string | `firstQuery` template. Supports `{{from}}`, `{{to}}`, `{{peer}}`, `{{label}}`. |

### Derived naming

- channel **title** = `<group>-<label>`
- channel **filename** = `<uuid>-<label>.json` (conforms to today's
  `<sessionId>-<channelId>` convention in `getChannelFile()`)
- `channelId` = `label` alone

### Invariants

- Session ids are **pure UUIDs** (`mail_to`'s `UUID_RE` is untouched — no
  protocol change). Labels never enter a sid.
- `match` (§6.2) = same `sessionId` **and** same `workdir` **and** canonical
  `args` equal **and** the process is alive.

## 4. `mycc-compose` CLI

`scripts/mycc-compose/mycc-compose.js` — the thin CLI entry. It registers the
tsx loader (`import { register } from 'tsx/esm/api'; register();`) and
dynamically imports a single `.ts` umbrella, then dispatches subcommands. All
logic lives in `scripts/mycc-compose/lib/` (`.ts` modules: `discovery.ts` =
readers + liveness predicates, `spec.ts` = load/validate, `channels.ts` =
materialization, `peers.ts` = launch/stop/match/repair, `cli.ts` = arg
parsing, plus per-subcommand `cmd-check.ts` / `cmd-up.ts` / `cmd-down.ts` /
`cmd-status.ts` re-exported from `index.ts`). The entry stays `.js` only
because npm/Windows `.cmd` wrappers need a `.js` target; `register()` lets it
load the `.ts` lib in-process. Registered as a `bin` entry in `package.json`
next to `mycc`, `mdcalc`, `mycc-mail`, `mycc-pretty-print`.

| Command | Behavior |
|---|---|
| `check <file>` | Validate the whole spec; resolve each peer (by pinned sid, and by `workdir` + canonical `args`); report `match` / `mismatch` / `stale`. **No mutation.** |
| `up <file>` | Full pipeline (§5). |
| `sync <file>` | Idempotent reconcile — `up` minus destructive stops. **This is the cron target.** |
| `down <file> [--stop]` | Remove the channel pairs; with `--stop`, terminate the peers (verify the heartbeat `pid` is alive *and* is a mycc process before killing). |
| `status <file> [--json]` | Deterministic report: per peer `{name, sessionId, live, matching, lastBrief}`, per channel `{label, bothFilesPresent}`. Note `live` and `matching` are **distinct**: `live` = alive pid; `matching` = spec and instance agree on `sessionId` + `workdir` + canonical `args`. CLI, GUI and cron all read the same JSON. |

## 5. The `up` pipeline

**Validate everything before mutating anything.**

0. Validate the spec; validate that each peer's `args` contain `--auto` or
   `--daemon`; reject duplicate `name`s; reject `channels[]` endpoints that do
   not name a declared peer. **Abort before any mutation.**
1. Assign a UUID to every `sessionId: null` peer; write it back **in place**
   into the spec file.
2. Walk `peers[]` **in array order**. Per `renew` (§6.2) decide
   *skip* / *stop→start* / *start*. Start = detached
   `mycc --session-id <sid> <args…>` with cwd = `workdir`; poll
   `identity.json` **and** the heartbeat file until fresh — and the recorded
   `pid` is alive. A fresh heartbeat alone is not liveness evidence: the
   heartbeat file can outlive its process, so both conditions are required.
   Stop = heartbeat `pid`, verified alive **and** a mycc process first.
3. **Repair pass** (see §6.4): if a fresh heartbeat exists but the identity
   entry is missing, read-merge-write the entry.
4. Materialize channels: write `<sidA>-<label>.json` + `<sidB>-<label>.json`
   with `channelId: label`, `title: <group>-<label>`, cross-filled
   `peerSessionId`, `joined: false` / `firstQuerySent: false`, templates
   substituted, the reciprocal reply contract appended, atomic write +
   read-back. The peers' 5s channel poll auto-joins and delivers `firstQuery`;
   **never hand-edit the booleans** (the poll re-persists in-memory state and
   clobbers edits).
5. Report.

**Launch in staged waves.** Starting ~20 instances at once loses entries from
`identity.json` (see §6.4).

## 6. Design constraints (each traced to a verified fact)

### 6.1 Args matching goes through one shared, table-driven util

Live instances publish their own redacted launch args in `identity.json`, and
the spec's `args` string is parsed with the **same util** — so the two sides
cannot drift. The util lives at `src/utils/arg-canonical.ts` and is loaded by
**both** `src/config.ts` (via tsx/TS) and the `mycc-compose` bin (whose `.js`
entry calls `tsx/esm/api`'s `register()` so plain `node` can import the `.ts`
module in-process). It is authored as `.ts` because tsx consumes `.ts`
directly and the bin's `register()` shim closes the gap from the `.js` side.

| Export | Consumer | Purpose |
|---|---|---|
| `BOOLEAN_FLAGS`, `STRING_FLAGS`, `DEFAULTS` | `config.ts` | the single canonical flag table, spread into `minimist()` |
| `formatLaunchArgs(parsed)` | `config.ts`, compose | **order-preserving** display string; `***` redaction; unset omitted |
| `parseArgString(raw)` | compose | table-driven `--k v` / `--k=v` / bare-flag scanner (no dependency) |
| `canonicalArgs(parsed)` | compose | **key-sorted** form, for equality only |
| `argsMatch(published, spec)` | compose | `canonicalArgs` compare with `***` as a wildcard |

Two distinct canonical forms, deliberately:

- `formatLaunchArgs` is **order-preserving** → the published identity string
  stays faithful to how the instance was actually launched (so the LLM's
  self-identity is unchanged).
- `canonicalArgs` is **key-sorted** → `--auto --skip-healthcheck` and
  `--skip-healthcheck --auto` compare equal. Using the display string for
  matching would false-mismatch on order alone and needlessly restart healthy
  peers.

Because both sides are parsed table-driven, the classic "Number vs String"
trap (`--token-threshold 80000`) cannot occur. A parity unit test asserts
`parseArgString(launchString)` agrees with
`minimist(launchString.split(/\s+/), {boolean, string})` across a fixture set.

### 6.2 `renew` has exactly two policies

| Value | Behavior during `up` / `sync` |
|---|---|
| `always` | Always stop (if running) and start fresh. |
| `onMismatch` *(default)* | Start only when no live peer matches the record; otherwise leave it running. |

`match` = same `sessionId` **and** same `workdir` **and** canonical `args`
equal **and** the process is alive (fresh heartbeat).

### 6.3 `--session-id` is the sole `src/` prerequisite for resuming

- `src/config.ts`: add `'session-id'` to the minimist `string` table; add
  `getPinnedSessionId()`.
- `src/session/index.ts`: `writeFreshSessionFiles()` uses
  `getPinnedSessionId() || randomUUID()`; `initializeSession()` validates the
  UUID and **refuses to start when a live process already holds that sid**
  (checked via the hoisted `isSessionLive()`).
- No coordinator plumbing: `src/index.ts` already forwards
  `process.argv.slice(2)` verbatim to the Lead.
- **Constraint:** re-pinning reuses an existing session directory, and
  `cleanupEmptySessions()` deletes sessions whose `first_query` is empty and
  older than one minute — the live-heartbeat guard only saves it while a
  process is alive. Therefore `up` **must** launch peers with `--auto` or
  `--daemon` (which seed `HEADLESS_FIRST_QUERY_MARKER`). Enforced as a hard
  validation rule (§5 step 0).

### 6.4 Identity-repair pass

`register()` retries at most 5 times; ~20 concurrent registrations contend and
some session ids end up **missing** from `identity.json` even though their
heartbeat files are fresh. `isFresh()` short-circuits on the missing entry
(`if (!(sessionId in map)) return false;`) *before* consulting the heartbeat,
so a live peer reads as offline. After launch, `up`/`sync` therefore
read-merge-write any entry that has a fresh heartbeat but no identity record.
Without this, `renew: onMismatch` would false-mismatch and needlessly restart
healthy peers.

### 6.5 Freshness is checked through one hoisted predicate

Freshness is currently derived three ways (`IdentityManager.isFresh`,
`pruneStaleEntries`'s heartbeat read, `cleanupEmptySessions`'s
`hasLiveHeartbeat`). One exported pure `isSessionLive(sid)` is added to
`src/peer/identity.ts`; the new bootstrap guard (§6.3) and the repair pass
(§6.4) call it instead of adding a fourth variant.

### 6.6 Launch peers via the `mycc` command — never the Lead entry

`node bin/mycc.js` and `node --import tsx src/lead.ts` both fail: the guard in
`src/loop/agent-repl.ts` requires Coordinator IPC. Always
`mycc [--session-id <sid>] <args…>`.

## 7. Files

| File | Change |
|---|---|
| `src/utils/arg-canonical.ts` | **new** — shared flag table + formatters/parsers (consumed by both `src/` via tsx and the `mycc-compose` bin via `register()`) |
| `src/utils/id-guard.ts` | **new** — `isSafeId` / `sanitizeId`, shared by `config.ts` and `spec.ts` |
| `src/config.ts` | spread shared tables into `minimist()`; `getLaunchArgs()` delegates; add `session-id` to `string`; `getPinnedSessionId()` |
| `src/types.ts` | `IdentityEntry.args?: string` |
| `src/peer/identity.ts` | `register()` publishes `args`; export `isSessionLive()` |
| `src/session/index.ts` | pinned id in `writeFreshSessionFiles()`; live-holder guard in `initializeSession()` |
| `scripts/mycc-compose/mycc-compose.js` | **new** — the CLI entry (registers tsx, imports the `.ts` umbrella, dispatches) |
| `scripts/mycc-compose/lib/{discovery,spec,channels,peers,cli}.ts` | **new** — the `.ts` lib modules |
| `scripts/mycc-compose/lib/cmd-{check,up,down,status}.ts` | **new** — per-subcommand implementations, re-exported from `index.ts` |
| `scripts/mycc-compose/lib/index.ts` | **new** — the umbrella re-exported by the `.js` entry |
| `package.json` | `bin` gains `mycc-compose` |
| `skills/mycc-compose/{SKILL.md,schema.md,script.md}` | **new** — progressive-disclosure skill |
| `docs/peer-topology.md` | this document |
| tests | arg parity (`src/tests/arg-canonical.test.ts`), spec validation + `updateSpecFile` (`src/tests/mycc-compose-spec.test.ts`) |

## 8. Verification

- `npm run typecheck` (+ `typecheck:test`) and `npm run lint` — note: the
  `mycc-compose.js` entry is a `.js` shim under `scripts/` (not `src/`), so
  `eslint.config.mjs`'s `parserOptions.project` block (scoped to `**/*.ts`)
  does not type-lint it; the `.ts` lib it imports is type-checked normally.
- `vitest run` — the full suite, plus the two new unit-test files above.
- **Manual smoke (not an automated test):** `mycc-compose check` → `up` →
  `status --json` shows both peers live+matching and both channel files present
  → kill one peer → `sync` restarts it under the **same** session id with the
  channel still joined → `down --stop`. This sequence was exercised by hand
  during development; it is *not* committed as an automated test, so it does not
  run in CI. Treat it as a documented manual procedure, not a guaranteed gate.

## 9. Out of scope (deferred)

- GUI: topology WebSocket protocol and `TopologyPanel.vue` (a thin view over
  `mycc-compose status --json`).
