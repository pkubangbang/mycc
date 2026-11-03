# Plan — split `@pkubangbang/filesync-manager` into its own repo, GitHub, npm

Status: **PLAN** (nothing executed yet). Target: `~/proj/filesync` → `github.com/pkubangbang/filesync-manager` → `@pkubangbang/filesync-manager@0.1.0` on npm; mycc consumes the published package.

**Decisions taken by the user (settled — not open for re-litigation):**

1. GitHub repo name: **`filesync-manager`** (the local directory stays `~/proj/filesync`, as the user named it).
2. Version: **0.1.0**, first publish.
3. **No CI.** The user publishes manually from the local machine.
4. mycc consumes the published package with a **caret range** (`^0.1.0`), not a permanent `link:` — the engine (watcher included) is expected to be as stable as `@pkubangbang/crossroad-detector`, so the publish-round-trip inner loop is acceptable.

Consequence of (3): the agent does **not** run `npm publish`. The agent stops at a verified, pack-inspected, git-pushed working tree and hands the publish command to the user; §4's auth gate therefore belongs to the user, not to an agent step.

## 0. Facts established by recon

| Fact | Value |
|---|---|
| Package | `@pkubangbang/filesync-manager` v0.1.0, `type: module`, ESM-only |
| Source (tracked, 17 files) | `src/{index,protocol,chunker,engine,store,share-index,audit-log}.ts`, `src/tests/*.test.ts` (6), `package.json`, `README.md`, `tsconfig.json`, `tsconfig.build.json` |
| Runtime deps | `chokidar@^6.0.0` only (+ node builtins `crypto/fs/path`) |
| Test deps | `vitest`, node builtins only |
| Build | `tsc -p tsconfig.build.json` → `dist/` (+ `.d.ts`, `declarationMap`, `sourceMap`), `prepack` runs it |
| `files` | `dist/`, `src/`, `!src/tests/`, `README.md` (LICENSE auto-included by npm) |
| Outward imports | **none** — no `../..` escapes; the package is already self-contained |
| npm registry | `@pkubangbang/filesync-manager` → **404, name free** |
| npm auth | `~/.npmrc` has a 40-char `//registry.npmjs.org/:_authToken`, but `npm whoami` → **E401** ⇒ the token is stale or non-publishing. **User's step**, not the agent's (§4). |
| gh auth | logged in as `pkubangbang`, scopes include `repo` ✓ |
| mycc remote | `https://github.com/pkubangbang/mycc.git` (branch `main`) |
| Sibling precedent | `@pkubangbang/crossroad-detector@^0.1.3` — already a published, externally-consumed package (optional `await import()` in `src/loop/crossroad.ts:50`) |
| Toolchain | node 22.22.2, pnpm 11.27.0, npm 10.9.7 |

**Every mycc touch-point that must change** (complete list):

- `package.json:42` — `"@pkubangbang/filesync-manager": "file:packages/filesync-manager"`
- `pnpm-workspace.yaml:1-4,6` — the `packages/*` member + its "workspace link not file: copy" comment
- `pnpm-lock.yaml:18,19,130` — regenerated, not hand-edited
- `vitest.config.ts:7` — `'packages/*/src/tests/**/*.test.ts'` in `include`
- `tsconfig.json:16,17` — `include`/`exclude` `packages/*/src/**/*`
- `tsconfig.test.json:9` — `include` `packages/*/src/**/*`
- `eslint.config.mjs:114-134` — two project-binding blocks keyed on `packages/*/src/**/*.ts`
- `src/peer/filesync/wire-codec.ts:88` — comment "(packages/filesync-manager)"
- `docs/peers/filesync.md:71, 231` — "(packages/filesync-manager/ in this repo while it is pre-publish)"
- `packages/filesync-manager/**` — removed (moved, not copied-and-kept)

Everything else (`src/peer/filesync/manager.ts:15-17`, `src/tests/peer/filesync-wire.test.ts:13`) imports by package **name** and needs no change.

---

## 0b. Layer boundary — this is the whole reason the package exists

The engine does **disk work only**; mycc owns the **wire**. Stated as an invariant because it decides what the package may ever contain:

| Layer | Owns | Lives in |
|---|---|---|
| Engine | walk the folder, fastcdc chunking, content-addressed piece store, manifests + tombstones + LWW, conflict preservation, atomic apply, the chokidar watcher, the gossip *clock* | `@pkubangbang/filesync-manager` — **zero** transport deps |
| Host (mycc) | the WebSocket channel, peer discovery/liveness, pairing, framing (`type:'sync-*'` verbs), binary piece frames, auth | `src/peer/filesync/` — implements `PeerPort` |

The seam is the injected port: `PeerPort { sendMessage, sendData, partners }` leaving the process, `onMessage` / `onData` entering it. `EngineHooks` (`getSelfSid`, `appendLocalMail`, `verbose`, `noteFileChange`) is the same deal for host-side effects. `src/protocol.ts` speaks domain words (`manifest`, `want-list`, `piece`, `deletion`) — never `sync-*`; mycc's `wire-codec.ts` is the **only** place the two vocabularies meet.

**Hardening consequence:** the invariant must be *enforced by a test*, not just documented — otherwise a future convenience import (`node:net`, `ws`, an `http` helper) silently makes the "transport-agnostic" claim false while everything still passes. That test is §1b item **H8**, and it is the one non-negotiable addition before the version is frozen.

## 1. Create `~/proj/filesync` (new standalone repo working tree)

```
~/proj/filesync/
  src/{index,protocol,chunker,engine,store,share-index,audit-log}.ts   # verbatim
  src/tests/*.test.ts                                                  # verbatim (6 files)
  tsconfig.json          tsconfig.build.json                           # verbatim
  package.json           README.md   LICENSE   .gitignore   (new/edited)
```

- `cp -r` from `packages/filesync-manager` then delete any `dist/` and `node_modules/` that ride along. `cp` the file list, not the directory wholesale, to avoid carrying `dist/`.
- `LICENSE` — copy mycc's `LICENSE` (MIT, "Copyright (c) 2026 pkubangbang"); a published package must ship it in its own repo.
- `.gitignore` (new, this repo has none of its own today):
  ```
  node_modules/
  dist/
  *.tsbuildinfo
  /coverage/
  *.log
  ```

**`package.json` edits** (keep the existing `files`/`exports`/`engines`/`publishConfig` — they were hardened in mycc commit `b0f28cc` "publish a build, not raw TypeScript"):

- add `"repository": { "type": "git", "url": "git+https://github.com/pkubangbang/filesync-manager.git" }`
- add `"homepage": "https://github.com/pkubangbang/filesync-manager#readme"`, `"bugs": { "url": "https://github.com/pkubangbang/filesync-manager/issues" }`
- add `"sideEffects": false`
- `scripts`: keep `build`, `prepack`, `typecheck`; **add** `"test": "vitest run"` and `"check": "npm run typecheck && npm test"`
- `devDependencies` (new — currently inherited from mycc's hoisted root): `typescript@^5.9.3`, `vitest@^4.1.10`, `@types/node@^24.13.5`
- `dependencies`: `chokidar@^6.0.0` (unchanged)
- version stays **0.1.0** (name is unclaimed; nothing to reconcile)
- README: adjust the "Why a separate package" paragraph — drop the "in the mycc repo" hedge, link the repo.

No vitest config file is needed: vitest's default `include` (`**/*.{test,spec}.?(c|m)[jt]s?(x)`) matches `src/tests/*.test.ts`, and it already excludes `node_modules`/`dist`.

**Verify locally before any git/npm step:**
```
cd ~/proj/filesync && npm install && npm run build && npm run typecheck && npm test
```
`src/tests/public-api.test.ts` is the contract test (imports only `../index.js`) — it must pass unchanged; it is the guard that the published surface still works for an outside consumer.

## 1b. Hardening gate — rigid tests before the tag

Runs in `~/proj/filesync` after §1, **before** §2's pack-inspect, §3's tag, and the user's publish. The existing suite is decent (41 `it`s across 6 files, including security cases R1/G1/G2/G5/G9), but it has real gaps that a published, version-frozen package cannot afford — the engine is about to become expensive to fix.

**Gaps found by recon (each is a test to add, not a code change unless the test fails):**

| # | New test | Invariant it pins | Why it matters now |
|---|---|---|---|
| H1 | `advanceTimers`-driven `PENDING_TTL_MS` expiry | a peer that answers nothing is evicted; the map does not grow | only *peer-left* pruning is covered today; TTL is untested |
| H2 | `MAX_PENDING_FILES` cap evicts oldest | memory is bounded under a fetch storm | cap never exercised |
| H3 | `REQUEST_WINDOW` / `MAX_REQ_BATCH` bound the want-list | one manifest cannot trigger an unbounded piece request | pump loop untested at its boundary |
| H4 | Engine **restart** over an existing `stateDir` | index + piece store reload; no re-hash of already-stored pieces; no duplicate gossip storm | publishing freezes on-disk state formats — this catches an incompatible format before consumers store data in it |
| H5 | conflict preservation end-to-end | a losing local edit lands on disk as `<name>.conflict-<sid>-<ts>` **and** produces exactly one `appendLocalMail`; the kept file holds theirs | `preserveLoser` is only covered structurally (ShareIndex) today — never through the engine |
| H6 | atomic apply leaves no `.filesync-tmp` behind | after a successful and after a failed apply, the tmp name is gone; a pre-planted symlink at the tmp name cannot clobber outside the root | G5 is implemented in `maybeApply` but has no adversarial test |
| H7 | zero-byte file, unicode/space filename, deep nesting | chunker and apply handle empty + non-ASCII paths; nothing is silently skipped | trivial to get wrong, impossible to fix after publish without a version bump |
| H8 | **no transport dependency** — precise form: `package.json.dependencies` is exactly the allowlist; no file under `src/` (or the built `dist/`) imports `node:net`, `node:http`, `node:http2`, `node:tls`, `node:dgram`, `ws`, or anything under mycc's `src/peer/`. Timers and `port.partners()` are **allowed and expected** | the layer boundary is *timing, not delivery*: the engine decides **what** to send and **when**, and learns **which** peers exist only as a returned set — it never stores channel state | enforces §0b mechanically without banning `setInterval`; the single most valuable guard for a package whose selling point is transport-agnosticism |
| H9 | barrel export set is stable | importing `../index.js` yields exactly the documented names; a dropped/renamed export fails loudly | `public-api.test.ts` pins *usage*, not the export list |
| H10 | gossip clock fires on `GOSSIP_MS` and `close()` clears it | fake timers advance → one manifest per partner per interval; after `close()`, advancing time emits nothing | "no timer leak after teardown" is currently watcher-only |

**Pass criteria (these make the suite *rigid*, not just bigger):**

- **Deterministic:** fake timers (`vi.useFakeTimers` + `vi.advanceTimersByTime`) for everything driven by `GOSSIP_MS`, `WATCH_DEBOUNCE_MS`, `PENDING_TTL_MS`, `SKEW_DEADLINE_MS`. Real `fs` events stay real (chokidar cannot be faked) — those tests keep a bounded real wait, and no test may sleep more than ~100 ms. Today there are **zero** uses of fake timers, so H1/H3/H10 are impossible to write reliably without this.
- **Mutation-sanity:** for each of H1–H10, break the corresponding line in `src/` locally and confirm the new test fails. A test that passes against a deliberately broken engine pins nothing.
- **No new runtime deps** and no new source dependencies — hardening is tests only, unless a test exposes a real defect (then the fix is a separate, called-out commit).
- **Wall clock:** `npm test` in `~/proj/filesync` stays well under a minute, so it can be run before every publish.

If a gap test fails, that is a **stop sign**: fix it in `~/proj/filesync` and re-run §1/§1b — the whole point of hardening before the tag is that the defect never reaches the npm version number.

## 2. Pack-inspect gate (do this BEFORE publishing)

`npm pack` writes `pkubangbang-filesync-manager-0.1.0.tgz`; then `tar -tzf` and assert:

- `package/dist/index.js` + `package/dist/index.d.ts` present, **`package/src/*.ts` present but no `src/tests/`**
- no `node_modules/`, no `*.tgz`, no `.ts` source as the entry (`main` must point at `dist/`)

This is the exact regression mycc already burned once (`b0f28cc`); it is cheap and reversible, unlike the publish.

**Why this step is load-bearing, not ceremonial:** `b0f28cc` added the `dist/`-not-raw-TS fix and the contract test, but the package was *never actually published* (`npm view` → 404), so the `"files": ["dist/", "src/", "!src/tests/", …]` manifest — negation patterns included — has never been checked against a real tarball. `.gitignore` also hides `dist/` from mycc, so no reviewer has ever seen the artifact. Step 2 is the first real verification of the publish manifest, and it is the last cheap moment before the name/version become permanent.

## 3. Git + GitHub

Local directory is `~/proj/filesync`; the **GitHub repo is `filesync-manager`**. Everything below runs inside `~/proj/filesync`, with the remote pointing at the `filesync-manager` repo.

```
git init -b main
git add -A && git commit -m "feat: extract @pkubangbang/filesync-manager from mycc"
gh repo create pkubangbang/filesync-manager --public --source=. --push --description "Transport-agnostic local file sync engine — FastCDC chunking, content-addressed piece store, LWW manifests"
git tag v0.1.0 && git push --tags
```

`gh` is already authenticated as `pkubangbang` with `repo` scope. Verify the remote afterwards: `git remote -v` → `https://github.com/pkubangbang/filesync-manager.git`.

## 4. npm publish — the user's step (manual, local)

**No CI.** The user publishes from this machine, so the agent stops here: the working tree is verified (§1), pack-inspected (§2), committed, and pushed (§3).

Hand off to the user:

1. **Precondition (user):** `npm whoami` currently returns **E401** even though `~/.npmrc` holds a 40-char token — that token is stale or lacks publish rights. Re-authenticate (`npm login`, or replace the token in `~/.npmrc`) until `npm whoami` prints `pkubangbang`.
2. **Publish (user):**
   ```
   cd ~/proj/filesync && npm publish --access public
   ```
   `publishConfig.access: "public"` already covers the scope, and `prepack` builds `dist/` automatically. `--access public` is passed explicitly for the first publish of a scoped name.
3. **Verify (either side):** `npm view @pkubangbang/filesync-manager version dist.tarball repository` → `0.1.0`, the tarball URL, and `github.com/pkubangbang/filesync-manager`.
4. No `--provenance` (it requires an OIDC CI runner). No CI, no release workflow — a version bump is a manual `npm version` + `npm publish`, same as `crossroad-detector`.

## 5. mycc surgery (only after the user's publish is confirmed on the registry)

One commit, in this order:

1. `git rm -r packages/filesync-manager` (move, not a twin copy — the workspace-link rule exists so no stale copy survives).
2. `package.json:42` → `"@pkubangbang/filesync-manager": "^0.1.0"`.
3. `pnpm-workspace.yaml` — delete the `packages:` member and the 4-line comment explaining `packages/*`; **keep** `nodeLinker: hoisted`, `allowBuilds`, `minimumReleaseAgeExclude` untouched.
4. `vitest.config.ts:7` → `include: ['src/tests/**/*.test.ts']`.
5. `tsconfig.json:16,17` → drop `packages/*/src/**/*` from `include` and `packages/*/src/tests/**/*` from `exclude`.
6. `tsconfig.test.json:9` → drop `packages/*/src/**/*`.
7. `eslint.config.mjs` — delete both `packages/*/src/**/*.ts` blocks (114-134); the `src/**` blocks already cover everything left.
8. `pnpm install` (regenerates `pnpm-lock.yaml`: `link:packages/filesync-manager` → resolved registry tarball with an integrity hash).
9. Comment/doc refresh: `src/peer/filesync/wire-codec.ts:88` "(packages/filesync-manager)" → "(the `@pkubangbang/filesync-manager` package)"; `docs/peers/filesync.md:71` drop "in this repo while it is pre-publish" and link `github.com/pkubangbang/filesync-manager`; `docs/peers/filesync.md:231` phase-2 row → "the `@pkubangbang/filesync-manager` package (github.com/pkubangbang/filesync-manager)".
10. Changelog: add the entry to `changelog-202611.md` (new file for this month) or `changelog-todo.md` per repo convention.

**Deliberate consequence:** mycc loses in-checkout editing of the engine — an engine fix becomes `version bump → user publishes → bump the range in mycc`. This is accepted because the engine (watcher included) is expected to be as stable as `@pkubangbang/crossroad-detector`, which mycc already consumes the same way. For occasional local co-development the escape hatch is `pnpm add @pkubangbang/filesync-manager@link:../filesync` (a symlink, never `file:`, which is the copy that goes stale silently). It is documented in `docs/peers/filesync.md` but **not** baked into `package.json` — a `../filesync` path resolves for nobody else and in no other checkout.

## 6. Verification

In `~/proj/filesync` — the agent's own gate, run before the handoff:
- `npm install && npm run build && npm run typecheck && npm test` — the 6 original test files plus the §1b additions (H1–H10) all green
- the §1b rigid-test pass criteria hold: fake timers where the clock matters, no test sleeping > ~100 ms, each new test verified to fail against a deliberately broken engine
- `npm pack` contents asserted exactly as in §2 (then delete the `.tgz`)

In `~/proj/mycc`, **after the user has published** and `npm view @pkubangbang/filesync-manager version` answers `0.1.0`:
- `pnpm install` clean, `pnpm-lock.yaml` resolves the package to a registry tarball with an `integrity` (no `link:`/`file:` specifier left)
- `pnpm test` (= typecheck:all + vitest run) green — the engine's 6 tests now run **only** in the new repo; mycc keeps `src/tests/peer/filesync-wire.test.ts` (codec/wire) and the peer-wire/filesync integration tests
- `pnpm lint` green
- `node -e "import('@pkubangbang/filesync-manager').then(m=>console.log(Object.keys(m).join(',')))"` prints the barrel exports from the installed copy
- smoke: start mycc with `--share test`, confirm the share binds and the watcher is armed (the engine loads over the real registry dep, not a workspace link)

## 7. Ordering & rollback

Ordering is the safety property. The agent's run ends at "ready to publish"; the user's publish is the hinge; mycc surgery follows it:

```
copy → verify → HARDEN (rigid tests) → pack-inspect → git push → [USER PUBLISHES] → mycc surgery → mycc verify
```

Nothing irreversible happens before the user's `npm publish`. If the package turns out wrong during §1–§3, `~/proj/filesync` is deleted and mycc was never touched.

- Directory move (mycc side): reversible (`git checkout packages/filesync-manager`, delete `~/proj/filesync`).
- GitHub push: reversible (repo can be deleted/renamed).
- **One-way door:** the user's `npm publish` — the scoped name and `0.1.0` are permanent (unpublish only within ~72h). Hence §2's tarball assertion runs first.
- mycc commit: revertible with `git revert`; the only residue is that the package exists on npm (harmless).
- **If the user publishes and then the mycc swap misbehaves:** mycc can fall back to `link:../filesync` in one line without any registry action — the published package is not a trap.

## 8. Pre-mortem — what most likely goes wrong

| Failure | Where it bites | Mitigation already in the plan |
|---|---|---|
| Published tarball ships raw TS or a `src/tests/` tree | Consumer gets an unbuildable package; unfixable without a republish | §2 pack-inspect, the one gate before the irreversible step |
| `npm whoami` E401 → publish aborts | User's §4 precondition; nothing corrupted, but the flow stalls after the repo is already public | Auth is a precondition the user checks *before* publishing; the agent never runs `npm publish` |
| mycc installed with the dep removed but the registry copy not yet resolvable | `pnpm install` prunes the link; typecheck fails on `manager.ts` imports | Strict ordering: the user's publish + `npm view` check precede any mycc edit |
| `pnpm install` needs a release-age/cooldown exception | `pnpm-workspace.yaml` keeps a `minimumReleaseAgeExclude` list, so a cooldown policy could exist — a brand-new version would then be rejected | Already checked: `pnpm config get minimumReleaseAge` → **undefined**, so no cooldown is active today. If one is enabled later, add `@pkubangbang/filesync-manager@0.1.0` to `minimumReleaseAgeExclude` (precedent: the `crossroad-detector` entry) |
| Six engine tests silently stop running in mycc | `pnpm test` still passes, so nobody notices the coverage left the repo | Expected and stated: the tests move with the package and run in `~/proj/filesync`. The wire/codec side stays in `src/tests/peer/` |
| A stale duplicate survives | The old rationale in `pnpm-workspace.yaml` exists precisely because a `file:` copy went stale | `git rm -r` the directory (a move, not a copy); the only allowed re-resolution is `link:`, never `file:` |
| Engine fix needed during mycc work | Inner loop crosses a publish boundary | Accepted: the engine is expected to be as stable as `crossroad-detector`. Emergency: `link:../filesync` in one line (§5) |
| Watcher instability (chokidar, debounce, race on scan→baseline) | Would force republish cycles — the one thing the split makes expensive | The engine already has watcher coverage (`src/tests/watcher.test.ts`) and a closed scan→baseline race (mycc `99af546`). §1 runs that suite in the new repo *before* publishing; if it is flaky, the publish is stopped, not shipped |

## 9. Settled decisions (previously open questions)

1. GitHub repo: **`filesync-manager`**; local directory: **`~/proj/filesync`**.
2. First version: **0.1.0**; mycc's spec: **`^0.1.0`** from the registry.
3. **No CI** — manual local publish by the user; provenance/release automation explicitly out of scope.
4. Engine stability (watcher included) expected to match `crossroad-detector`; the publish round trip is the accepted inner loop.
