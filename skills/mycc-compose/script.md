# mycc-compose — the script

`scripts/mycc-compose/mycc-compose.js` — the thin CLI entry. It registers the
tsx loader (`import { register } from 'tsx/esm/api'; register();`) and
dynamically imports a single `.ts` umbrella, then dispatches subcommands. All
logic lives in `.ts` modules under `scripts/mycc-compose/lib/`:

| Module | Responsibility |
|---|---|
| `mycc-compose.js` | Entry: registers tsx, imports the umbrella, subcommand dispatch (`check`/`up`/`sync`/`down`/`status`). |
| `lib/index.ts` | Umbrella: re-exports the subcommands + cli helpers. |
| `lib/discovery.ts` | identity.json / heartbeat readers + the two liveness predicates (`isSessionLive` = freshness only; `isPeerRunning` = freshness **and** live pid). |
| `lib/spec.ts` | `loadSpec` / `validateSpec` (pure, unit-tested) / `updateSpecFile`. |
| `lib/channels.ts` | channel-file materialization, removal, status. |
| `lib/peers.ts` | launch / stop / match / identity-repair. |
| `lib/cli.ts` | usage text, arg parsing, exit helpers. |
| `lib/cmd-check.ts` / `cmd-up.ts` / `cmd-down.ts` / `cmd-status.ts` | the four subcommand implementations. |

Registered as the `mycc-compose` bin in `package.json` (after `npm link` / a
global install it is on PATH and works from any directory).

The lib modules are `.ts` and import node built-ins plus project `.ts` modules
(the shared flag table `src/utils/arg-canonical.ts` and `src/utils/id-guard.ts`,
and sibling `lib/*`). The entry stays `.js` only because npm/Windows `.cmd`
wrappers need a `.js` target; the `register()` call lets it load the `.ts` lib
in-process without spawning a child or compiling ahead of time.

Run during development:
```
node scripts/mycc-compose/mycc-compose.js <command> <file>
```

## Subcommands

```
mycc-compose check  <file>            Validate + report match/stale. No mutation.
mycc-compose up     <file>            Full pipeline: mint sids, launch/renew, write channels.
mycc-compose sync   <file>            Idempotent reconcile (up minus destructive stops). CRON TARGET.
mycc-compose down   <file>            Terminate the peers, then remove the channel pairs.
mycc-compose status <file> [--json]   Deterministic report. --json for machines.
mycc-compose --help, -h               Show help.
```

### `check`
Validates the whole spec and reports, per peer: `match` (running + same
sid/workdir/args), `mismatch` (running but args/workdir differ), or `stale`
(not running). Also reports each channel's file-pair completeness. **Never
mutates** the spec or the discovery store.

### `up` — the full pipeline
1. **Validate** the whole spec (abort before any mutation on failure).
2. Mint a UUID for every `sessionId: null` peer and **write it back in place**
   into the spec file.
3. Walk `peers[]` **in array order**, deciding per `renew`:
   *skip* (running + match, `onMismatch`) / *stop→start* / *start*.
4. Launch the starters in **staged waves** (small batches) — launching ~20 at
   once loses identity registrations to write contention.
5. Wait for each peer to be reachable, then run the **identity repair pass**
   (reconstitute any entry that has a fresh heartbeat but no identity record).
6. **Materialize** both channel files per link.
7. Report.

### `sync` — the resume path
Identical to `up` **minus destructive stops**: a peer that is running but
mismatched is left alone (reported, not killed). This is safe to run on a
timer — it starts what is down and skips what is healthy, without ever tearing
down a live instance. **This is the cron target.**

### `down`
Terminates each peer — but only after verifying its heartbeat `pid` is
**alive** AND (best-effort) a `mycc`/node process. Refuses otherwise and
reports why (`stopped`, `already-stopped`, `heartbeat-fresh-but-pid-dead`,
`refused-not-mycc`, ...). Then removes every channel file owned by the spec's
peers for the spec's labels. **`down` always stops the peers**: removing the
channel files alone has no meaning, so there is no channels-only mode and no
`--stop` flag.

### `status`
Deterministic, **no LLM**:
```json
{
  "group": "pr26",
  "peers":   [ { "name": "a", "sessionId": "…", "live": true, "matching": true, "lastBrief": null } ],
  "channels":[ { "label": "review", "bothFilesPresent": true } ]
}
```
`live` = running (fresh heartbeat **and** a live pid). `lastBrief` is the
peer's most recent brief (`{time, content, confidence}`) or `null`. CLI, GUI,
and cron all read the same JSON.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success (all requested peers up / all files written). |
| `1` | Runtime or validation error (bad spec, launch failure, peer not live in time). |
| `2` | Usage error (unknown command/option, missing `<file>`). |

## Cron wiring (auto-resume)

Auto-resume is **re-running `sync`**, not an in-process boot hook. Use the
existing no-LLM automation path: a `--daemon <skill>` whose skill declares
`service_cron`. Point the cron at:

```
mycc-compose sync /abs/path/to/spec.json
```

Each tick: down peers restart under their pinned session ids; healthy peers are
skipped; channel pairs are re-ensured. Because `sync` never stops a running
peer, the timer can be frequent without flapping.

## Notes & pitfalls

- **Never launch the Lead entry directly** (`node bin/mycc.js` / `tsx
  src/lead.ts` both trip the agent-repl guard). The script launches
  `node <resolved bin/mycc.js> …` precisely as the `mycc` command does, with
  `detached:true, stdio:'ignore'` so the child is a true background process —
  it does **not** use the npm shim with a shell (which foregrounds the peer on
  Windows and grabs the console title).
- **`peers[].args` must contain `--auto` or `--daemon`** (hard validation) —
  otherwise `cleanupEmptySessions()` can GC the re-pinned session dir.
- **Never hand-edit the channel booleans** — the peers' 5s poll re-persists
  in-memory state and clobbers edits.
- Liveness is **fresh heartbeat AND live pid**; a just-killed peer is correctly
  reported `down` (its stale heartbeat must not block a restart).

## See also

- `docs/peer-topology.md` — the full design/plan (schema, pipeline, constraints).
- `schema.md` — the spec field reference and examples.
- `mediator` skill — the manual procedure this tool automates.
