# mycc-compose — Review Fix Round (plan + record)

> **Addendum (post-migration, 2026-09-30):** this document records the fix round
> *as it landed at the time*, and the file paths in the body reflect the
> pre-migration layout. A subsequent migration dissolved the `src/utils-esm/`
> boundary entirely: `arg-canonical` and `id-guard` moved to
> `src/utils/{arg-canonical,id-guard}.ts` (plain TypeScript, loaded via the
> `tsx/esm/api` `register()` loader installed by the `.js` bin shim), and the
> compose lib files `lib/{discovery,spec,channels,peers,cli}.js` became
> `.ts`. So every path below of the form `src/utils-esm/<util>.js` now lives at
> `src/utils/<util>.ts`, and every `lib/<mod>.js` is now `lib/<mod>.ts`. The
> *fixes themselves are unchanged* — only their carrier files were renamed and
> retyped. Read the body as a historical record; for the current layout see
> `docs/peer-topology.md` and `skills/mycc-compose/script.md`.

Status: **fixes landed and verified — awaiting the human-gated commit** (todo #15).
Branch `feat/mycc-compose-peer-topology`, uncommitted. All five blockers and the
majors listed below are fixed, pinned by tests, and green across the full suite.

This document is the plan *and* the record of the fix round that followed the
four-reviewer audit of the `mycc-compose` peer-topology feature. It maps every
blocker to its fix, names the file that carries the fix, and states how the fix
was verified. It is deliberately concrete: a reader should be able to re-verify
each row without re-deriving the reasoning.

## 1. Where the findings came from

Four focused reviews, each with a distinct ownership lens, filed findings as
comments on their own issue:

| Review | Issue | Lens | Counts |
|--------|-------|------|--------|
| A — `reviewer-launcher` | #2 | launcher, process lifecycle, liveness | 1 blocker, 4 major, 6 minor |
| B — `reviewer-contract` | #3 | spec validation + arg contract | 2 blocker, 5 major, 3 minor |
| C — `reviewer-tests` | #4 | tests + docs integrity | 1 blocker, 4 major, 3 minor |
| D — `reviewer-safety` | #5 | robustness, path safety, blast radius | 2 blocker, 5 major, 3 minor |

**Totals: 5 blockers, 16 majors, 15 minors.** (Two blockers were independently
found by two reviewers each — B-SEC-1 by D and B; B-CONTRACT-1 by C and B.)

## 2. The five blockers and their fixes

| ID | Defect (one line) | Fix landed in |
|----|-------------------|---------------|
| B-SEC-1 | Channel `label` was validated as "non-empty string" only, then interpolated into `path.join(CHANNELS_DIR, '<sid>-<label>.json')` — a label `x/../../identity` escaped the directory and overwrote the machine-wide `identity.json`. | `src/utils-esm/id-guard.js` (new) + `src/config.ts` + `scripts/mycc-compose/lib/spec.js` |
| B-SEC-2 | `removeChannels` cross-produced every session id × every label, so `down` deleted *other* groups' channel files. | `scripts/mycc-compose/lib/channels.js` (`channelFileNames(spec)`) |
| B-LAUNCH-1 | The spawn argv was built with the **redacting** formatter, so a spec's `--wire-token REAL` reached the child as the literal `***` — i.e. peers launched silently unauthenticated. | `src/utils-esm/arg-canonical.js` (`formatLaunchArgsForSpawn`) |
| B-LAUNCH-2 | The "is this pid mine to kill?" check matched `node.exe`, which matches **any** Node process on Windows; the negative branch was dead. | `scripts/mycc-compose/lib/peers.js` (Fix A) |
| B-CONTRACT-1 | `-v` is a minimist alias, so a real instance published `--v --verbose --auto` while a spec renders `--verbose --auto` → `argsMatch` was `false` for **every** healthy `-v` peer, so `up` renewed them and `sync` reported a permanent mismatch. The parity test's normalizer hid it. | `src/utils-esm/arg-canonical.js` (+ the test) |

### 2.1 B-SEC-1 — one guard, two consumers

The guard already existed, but as a **private function of `src/config.ts`** — a
`.ts` module the zero-dependency compose CLI (plain `node`) cannot import. That
is precisely why the compose path never got the protection. The fix extracts it:

    src/utils-esm/id-guard.js      <- the single implementation
    src/utils-esm/id-guard.d.ts    <- types for the TS side
      isSafeId(id)                 -> boolean
      sanitizeId(id, label)        -> string (throws with the field name)

`config.ts` imports it (its private copy is deleted); `spec.js` imports it and
calls `sanitizeId(c.label, \`channels[${i}].label\`)`. The guard rejects `/`, `\`,
`..`, control characters, **and** the Windows-reserved filename set `: * ? " < > |`
(the reserved set is new: those characters are not separators, so a traversal-only
check lets them through and `fs` fails later with a confusing error).

### 2.2 B-SEC-2 — scope deletion to what the spec owns

`removeChannels` now takes a **filename list**, not a (peers × labels) pair of
lists, and `channelFileNames(spec)` is the single definition of "the files this
spec owns". Cross-product deletion is structurally impossible.

### 2.3 B-LAUNCH-1 — redaction is a display concern

One renderer backs both formatters, parameterized by a `redact` flag:

    formatLaunchArgs(parsed)          -> order-preserving, REDACTING   (display / identity.json)
    formatLaunchArgsForSpawn(parsed)  -> order-preserving, NON-redacting (child argv)

### 2.4 B-CONTRACT-1 — fold aliases, then assert for real

`ALIASES = { v: 'verbose' }` + `canonicalFlagName()` normalize both forms to the
long name at every point that matters: the parser's `setValue()`, the group map
used by `argsMatch()`, and the renderer's dedupe. The parity test no longer uses
a normalizer that can hide a divergence; it asserts **canonical equality** of the
two sides plus `argsMatch(theirs, mine) === true`.

Note on where the two plain-ESM utils live: they are under **`src/utils-esm/`**
(`arg-canonical.{js,d.ts}`, `id-guard.{js,d.ts}`), deliberately separate from the
TypeScript modules in `src/utils/` because they are runtime-only helpers loaded by
BOTH `tsx` and the zero-dependency bins, and are therefore not part of
`tsconfig.json`'s program (`allowJs` is false). The `eslint.config.mjs` typed-lint
scope keys on `**/*.ts`, so the ESM pair is linted without type-aware rules.

Note on what is *not* asserted: byte-for-byte string equality is **not** a
contract and cannot be — `formatLaunchArgs` is order-preserving, and minimist
walks its own key order (defaults first), so `--auto --skip-healthcheck` renders
as `--skip-healthcheck --auto` on the minimist side. Asserting string identity
there would encode a guarantee the design never made.

## 3. Majors addressed in the same round

| Majors | Fix |
|--------|-----|
| A-M4 — `LAUNCHER_FLAGS` authored in `peers[].args` | `spec.js` rejects `--session-id` in a spec (the launcher injects it; an authored one doubles the flag → array → `getPinnedSessionId()` null → 30s timeout + orphan) |
| B-M1 / B-M2 — bare `--daemon` parses to `''` vs `true` | the parser now records `true` for a valueless string-flag |
| B-M3 — `updateSpecFile` non-atomic | rewritten as tmp + `renameSync` |
| D-3 — re-run clobbers `joined` / `firstQuerySent` | `buildChannelFile({existing})` preserves them from the on-disk file |
| D-4 / B-M5 — case-insensitive + Unicode duplicate labels | duplicate detection uses `normalize('NFC').toLowerCase()` |
| D-6 — weak read-back after write | `writeChannelFileAtomic` also verifies `peerSessionId`; tmp cleanup on failure |
| A-M1, A-M2 / D-5 | Fix A **landed** in `peers.js` + `discovery.js`, pinned by `src/tests/mycc-compose-peers.test.ts` (12 tests) |
| C-M1–C-M4 — test/doc gaps | `src/tests/mycc-compose-spec.test.ts` (label traversal, case-fold dup, launcher-flag rejection, `channels[i]` shape, `updateSpecFile`), `arg-canonical.test.ts` parity rewrite, `mycc-compose-channels.test.ts` (C-M3), `mycc-compose-peers.test.ts` |

## 4. Verification

Every fix is verified by running the real modules, not by inspection:

    npx tsc --noEmit          # typecheck (both configs)
    pnpm lint
    pnpm test                 # full vitest suite

Targeted evidence recorded during the round:

- `npx vitest run src/tests/id-guard.test.ts src/tests/mycc-compose-spec.test.ts src/tests/arg-canonical.test.ts`
  → **114/114 pass** (id-guard 48, arg-canonical 35, compose-spec 31) — the
  latest run, after the §5.2 fixes and their new tests.
- `npx tsc --noEmit` → **exit 0**; `npm run lint` (`eslint src/`) → **exit 0**.
- Behavioral node probes against `arg-canonical.js`: `-v --auto` publishes
  `--verbose --auto` on both sides; `argsMatch('--v --verbose --auto', '--verbose --auto') === true`;
  `formatLaunchArgsForSpawn` preserves a REAL secret while `formatLaunchArgs` redacts it.
- Behavioral node probes against `spec.js` / `channels.js`: every unsafe label is
  rejected, valid ones accepted; `L`/`l` collide; `--session-id` rejected;
  `channels:[null]` rejected; bare `--daemon` → `--daemon`.

## 5. Honest residuals

These are **known and asserted**, not silently accepted:

1. **A bare `--daemon` diverges on the minimist side.** minimist types `daemon`
   as a string flag, so `--daemon` alone parses to `""`, which the renderer drops.
   Our parser records `true`. A test pins this asymmetry explicitly so it is a
   documented fact; the documented spec form `--daemon <skill>` is in parity.
2. **`--autofly` has the same shape** (string flag) and the same caveat.
3. **Byte-for-byte rendering is NOT a contract** between the two sides. minimist
   walks its own key order, so `--auto --skip-healthcheck` renders as
   `--skip-healthcheck --auto` there. The contract is *canonical* equality, which
   is what `argsMatch` uses and what the parity tests assert.

### 5.1 `sanitizeId` strictness beyond traversal (a defensive, not exploitable, gap)

While verifying Fix B I probed `sanitizeId` with Windows-specific names and found
it accepted `task.`, `task `, `.`, `NUL`, `CON`, `COM1`, and a 256-char name.

**I could not demonstrate an exploitable consequence on this platform.** Direct
tests showed:
- trailing dot did **not** collide: `uuid-task..json` and `uuid-task.json` were
  two distinct files, each reading back its own content;
- `NUL.json`, `NUL`, and `task .json` all wrote and listed normally through Node.

So the correct description is a **strictness/docs mismatch**, not a blocker: the
guard accepted names whose Windows behaviour is platform- and
configuration-dependent. Since rejection is free, the guard now also rejects:
- a trailing dot or space (Windows may strip it, so the name is not stable);
- Windows device basenames (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`,
  `LPT1`–`LPT9`), matched against the basename before the first dot, so
  `nul.txt` is rejected while `NULLIFY` and `COM10` are not.

The source comment says plainly that this is defensive, so a future reader does
not mistake it for a patched exploit. `src/tests/id-guard.test.ts` (46 tests)
pins both the rejections and the deliberate non-rejections.

### 5.2 Two regressions found by adversarial verification (#9) and fixed

Adversarial verification of Fix B (issue #9) surfaced two further defects, both
now fixed and pinned by tests:

1. **#9-1 (major) — case-folded duplicate detection against raw-name lookups.**
   Duplicate peer names were detected on a folded key (`dupKey`), but the
   `channels[].from` / `.to` resolvers matched against the RAW name. A peer
   named `"Leader"` was therefore accepted by the duplicate check yet threw
   `channels[0].from must name a declared peer`. Fix: `dupKey` is now
   **exported** from `lib/spec.js`; both sides fold at `spec.js` (`:128/:131`,
   including the `.from === .to` guard) and `lib/channels.js` imports
   `{ dupKey }` and folds all three `byName` maps / six `.get` calls. Probe
   re-run: all three case variants resolve.
2. **#9-2 (minor) — unbounded id length.** `src/utils-esm/id-guard.js` gained
   `MAX_ID_LENGTH = 200`; `isSafeId` rejects an over-length id and `sanitizeId`
   throws `/too long \(N > 200 chars\)/`.

### 5.3 Doc drift fixed (§5 item 4)

Four doc statements that no longer matched the code are corrected in
`docs/peer-topology.md` and `skills/mycc-compose/schema.md`:

1. the label charset rule (the reserved set is rejected, not just separators);
2. liveness = **fresh heartbeat AND live pid**, not a fresh heartbeat alone;
3. the status-JSON `matching` field — it is distinct from `live` (`live` = alive
   pid; `matching` = spec and instance agree on `sessionId` + `workdir` +
   canonical `args`);
4. `peers[].sessionId` is **optional** (defaults to `null`, minted and written
   back in place) — schema.md previously said "Required: yes".

## 6. Remaining work

- [x] Fix A lands (issue #6, `reviewer-launcher`): B-LAUNCH-2, A-M1, A-M2/D-5 —
      in `scripts/mycc-compose/lib/peers.js` + `discovery.js`, pinned by
      `src/tests/mycc-compose-peers.test.ts` (12 tests), confirmed by
      `reviewer-safety` in the adversarial pass (#9).
- [x] Re-run `tsc` + `lint` + full suite over the combined fix set —
      `npx tsc --noEmit` (main + `tsconfig.test.json`) → **exit 0**;
      `npm run lint` → **exit 0**; full `vitest` (bg run, `.mycc-fullsuite.log`)
      → **180/180 files, 2730 passed / 17 skipped, exit 0** (28.95s). Baseline
      before the round was 177 files / 2616 passed.
- [x] Doc pass: `docs/peer-topology.md` (status-JSON `matching` vs `live`,
      "fresh heartbeat **AND** live pid", label charset rule) and
      `skills/mycc-compose/schema.md` (`sessionId` is *optional*, defaulting to
      `null`, minted and written back in place — not "Required: yes").
- [x] `src/tests/mycc-compose-channels.test.ts` added (C-M3 gap; B-SEC-2, D-3,
      D-6, `channelFileNames`, `removeChannels`, `channelStatus`).
- [x] **Directory move:** the two plain-ESM utils moved out of `src/utils/` into
      **`src/utils-esm/`** — `arg-canonical.{js,d.ts}` and `id-guard.{js,d.ts}`.
      The split makes the "runtime-only, not in tsconfig's program" boundary
      explicit instead of a per-file exception inside `src/utils/`. All 11
      dependent sites updated (`src/config.ts`, `src/types.ts`,
      `scripts/mycc-compose/lib/{spec,peers}.js`, `src/tests/{id-guard,arg-canonical}.test.ts`,
      `eslint.config.mjs`, `docs/peer-topology.md`, `skills/mycc-compose/script.md`,
      this doc). Re-verified: both `tsc --noEmit` configs **exit 0**,
      `npm run lint` **exit 0**, full `vitest` **180/180 files, 2730 passed /
      17 skipped, exit 0** (23.01s). No stale `src/utils/<util>` reference remains.
- [ ] Commit + PR — **human-gated** (todo #15, pinned). No commit until a human
      approves. The Fix A working-tree versions of `peers.js` / `discovery.js`
      (still `AM` — the index holds the pre-fix copy) MUST be staged at that
      point.
