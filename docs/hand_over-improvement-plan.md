# hand_over Improvement Plan — Final (Revised)

Source: `~/proj/feedback/hand_over-improvement-feedback.md` (6 issues: P0-1, P0-2, P1-1, P1-2, P2-1, P2-2)
Analysis: 3 analyst teammates (analyst-a/b/c), lead-integrated. User-reviewed design decisions marked **[LOCKED]**.

## Design Principles (user-stated, govern all changes)

1. **Intent Lang shapes LLM mindset.** The `RUN USER` rule for hand_over is *deliberately* not spoon-fed — the LLM must reason from the always-on verb/object tables to choose it. Hints guide *which dimension* is wrong, never the answer.
2. **hand_over popup is human-owned.** The user watches the popup, decides when they're done, answers `[y/N]`. Whatever is on the pane at that moment is the truth the LLM must read-and-judge. No exit-code marker, no poll loop, no default inversion.
3. **Dangerous commands are always forbidden by default.** The escape hatch is an Intent Lang PARAM (`dangerous=i_know`) that makes the LLM declare awareness honestly; the system steps back and routes to user confirmation. No parallel `dangerous: boolean` flag on hand_over.

---

## Cluster A — Intent Validator (P0-1) + Docs Gap (P2-1)

### A1. Socratic dimension-naming rejection hint  **[LOCKED]**  ·  `src/tools/hand_over.ts:96-98`

**BEFORE:**
```ts
if (!parsed || parsed.object !== 'USER') {
  return `Your intent suggests this task can be done without user interaction. Is that correct?`;
}
```

**AFTER:**
```ts
if (!parsed) {
  return `Intent format is: VERB OBJECT [key=value ...] TO PURPOSE. Re-read the verb/object tables and try again.`;
}
if (parsed.object !== 'USER') {
  return `hand_over opens a terminal popup for a human to type into (e.g. a sudo password). ` +
    `Your OBJECT "${parsed.object}" doesn't match that. Reconsider which OBJECT in your table means "a human interacting with a terminal," then retry.`;
}
if (parsed.verb !== 'RUN') {
  return `hand_over executes the command in that popup. Your OBJECT is right, but your VERB "${parsed.verb}" doesn't mean "execute a command or process." Reconsider which VERB fits, then retry.`;
}
```

Names the wrong dimension (object vs verb), withholds the correct token. LLM re-reasons from the always-on tables. Cuts the 3-round blind-guess tax without dissolving the gate.

### A2. PURPOSE-clause soft-accept  **[DROPPED]** — would bypass the reasoning gate.

### A3. Surface `RUN USER` rule in tool description / `OBJECT_MEANINGS.USER`  **[DROPPED]** — spoon-feeds the always-on surfaces. Rule lives only in MYCC.md (B2) as a retrievable fallback.

### B1. Fix stale field name  ·  `MYCC.md:587`  **[LOCKED, Socratic wording]**

**BEFORE:** `...requires intent language validation with a justification parameter.`
**AFTER:** `The hand_over tool requires an intent parameter in the intent language format: VERB OBJECT TO PURPOSE. Choose the VERB and OBJECT that best describe needing a human to interact with a terminal popup.`

Fixes the `justification` → `intent` bug without leaking the `RUN USER` answer.

### B2/B3. Add hand_over usage subsection to `MYCC.md` (~line 580-590)  ·  includes the multi-line note from P2-2b

Spelled-out `RUN USER` rule + worked examples live here (retrievable via `get_node`, not always-on). Cross-link from the tool description to this section. Include the P2-2b multi-line note: `command must be a valid JSON string; literal newlines must be escaped as \n; prefer && / ; / || on a single line for reliability.`

---

## Cluster B — Runtime / Output Capture (P0-2) + tmux Nesting (P1-1) + Usability (P2-2)

### P0-2. Linux capture-pane defect  **[LOCKED: capture-only fix]**

**Goal:** When the user answers `[y/N]`, `capture-pane -p -S -3000 -E -1` must return the full pane content visible to the user. Works on Windows/psmux; broken on Linux (returns only 2 lines — the sudo prompt — not the command output).

**Dropped sub-proposals:**
- P0-2a exit-code marker (`__HANDOVER_DONE_RC_$$__=$?`) — **DROPPED**. Conflicts with human-owned popup: user may run more commands, making RC ambiguous. LLM must guess from output.
- P0-2b `waitForCompletion` poll loop — **DROPPED**. User answers after watching; command already done.
- P0-2c default inversion (empty Enter → keep) — **DROPPED** per user instruction.

**Root cause — UNCONFIRMED, parked for implementation-phase reproduction (no experiments in plan mode):**
- Candidate A: tmux `history-limit` default (2000) < requested `-S 3000` → silent clamp.
- Candidate B: `exec bash` (line 116) resetting pane state on certain tmux builds.
- Candidate C: pane width `-x 120` wrapping long `umount && mkfs` lines differently than displayed.
- Candidate D: `-E -1` semantics differ across tmux versions / psmux.

**Implementation-phase action:** Spawn a `mycc-` style detached session (`tmux new-session -d -s test -x 120 -y 40 "bash -c '...; exec bash'"`), run a multi-line command, compare `capture-pane -p -S -3000 -E -1` vs `capture-pane -p` (no flags) vs `tmux show-buffer`. Isolate the responsible flag/history-limit, then fix the capture call. **No code change spec until reproduction isolates the cause.**

### P1-1. tmux nesting self-check  **[LOCKED]**  ·  `src/tools/hand_over.ts` after `hasTmux()` (~line 99)

If `process.env.TMUX` is set AND command matches `tmux (attach|a|switch-client|switch)` **including the `tmux -L <socket> attach` form**, reject with two alternatives only:
1. Ask the user to run `tmux attach -t <name>` in their own terminal (outside mycc).
2. Drive remotely via `tmux send-keys -t <name> '<cmd>' Enter` + `tmux capture-pane -t <name> -p`.

**Do NOT offer the `unset TMUX &&` escape hatch** — inviting it encourages routine use with known rendering/input glitches. Power users can discover it themselves.

Regex covers `attach`, `a`, `switch-client`, `switch`, and the `-L <socket>` prefix form. Does NOT block `new-session`/`kill-session`/`send-keys` (safe from inside tmux).

### P2-2a. sudo-prompt visibility  **[DROPPED as code change]**

Redundant once P0-2 capture is fixed — the sudo prompt will be visible in the captured output, and the LLM can warn the user itself. The `sudo -n true` probe adds cost (3s timeout) and false-positive risk (slow PAM/LDAP). Revisit only if post-fix testing shows the prompt still isn't surfaced clearly.

### P2-2b. Multi-line command  **[DOCS-ONLY, folded into B2]**

Confirmed via `od -c`: base64 round-trip preserves newlines. The flattening symptom originated upstream in JSON/tool-call serialization, not in hand_over's encoding path. Documentation note added to the `command` schema description and the B2 MYCC.md subsection. No code change to encoding.

---

## Cluster C — Formatting-Guard Deadlock (P1-2) + dangerous-commands Semantics

### C1. Intent Lang escape param `dangerous=i_know`  **[LOCKED]**  ·  `src/context/grant/bash-judge.ts:44-49`

**Flow:** When `checkDangerousCommand` matches AND the parsed intent contains `dangerous=i_know`, skip the hard-block AND skip the LLM analysis (step 5); route directly to user confirmation (step 6). The LLM's honest declaration is the trigger; the human's y/N is the gate.

Example: `WRITE SYSTEM cmd=mkfs dangerous=i_know TO format the flash drive` → user sees `Dangerous command acknowledged by agent. Command: sudo mkfs.vfat ... Purpose: format the flash drive. Allow? [y/N]`.

**`dangerous=i_know` is already syntactically valid** under the existing PARAM tokenizer (`^[a-z_]+=[^\s=]+$` at intent-parser.ts ~line 80) — no parser change needed. The underscore in `i_know` is an informational-exceptional signal to the LLM (user-stated).

**Scope of override:** `destructive` and `irreversible` categories route to user confirmation when `dangerous=i_know` is present. `system` category (git commit, npm publish — routing nudges, not danger gates) stays hard-blocked.

### C2. Socratic hint for the non-override path  **[LOCKED]**  ·  `src/context/grant/bash-judge.ts:44-49`

When a dangerous command is blocked WITHOUT the escape param, replace `Command blocked: <reason>` with:

```
Command blocked: <reason>.

Dangerous commands are blocked by default. The Intent Lang provides a PARAM
that declares your awareness of the risk and routes the decision to the user.
Consult the intent language PARAM conventions and retry if this is intended.
```

Names the existence of a PARAM override, withholds the exact key/value. The LLM consults the PARAM docs (C5), sees `dangerous`, makes the connection.

### C3. Observation-skip for pure-observation tmux subcommands  ·  `src/context/grant/dangerous-commands.ts`

Add a narrow `INDIRECT_WRAPPERS` skip list: `tmux capture-pane`, `tmux show`, `tmux display-message`, `tmux list-sessions`/`list-windows`/`list-panes`. These never execute in the target pane → dangerous-pattern check skips them entirely.

**`tmux send-keys` is NOT in the skip list** — it executes in the target pane, so it routes through the dangerous check; if it matches, the LLM must declare `dangerous=i_know` and the user confirms.

### C4. `EXEC_WRAPPERS` defense  ·  `src/context/grant/dangerous-commands.ts`

`sh -c`, `bash -c`, `eval`, `$(...)`, backticks, `xargs`, `find -exec` — always checked even when indirect, so obfuscation can't bypass the dangerous-pattern match. Defense-in-depth; no downside.

### C5. Document `dangerous=i_know` in the PARAM documentation  **[LOCKED]**

Add `dangerous` to the PARAM conventions emitted to the LLM system prompt (always-on, so the C2 Socratic hint can guide the LLM to find it). Also document in MYCC.md.

**Contract:** "Dangerous commands are blocked by default. To request execution, declare `dangerous=i_know` in your intent PARAMs — the system skips its safeguards and asks the user to confirm. Pure observation (`tmux capture-pane`/`show`/`list-*`) is always allowed. `tmux send-keys` routing a dangerous command requires `dangerous=i_know` + user confirmation."

### C6. Drop the `dangerous: boolean` hand_over flag  **[LOCKED]**

The intent param is the sole override channel. hand_over's `RUN USER` intent remains its authorization; the bash tool's dangerous override is `dangerous=i_know`. No parallel channel, no spoon-feeding.

---

## Implementation Order (revised)

| Step | Change | File | Priority | Depends on |
|------|--------|------|----------|------------|
| 1 | Socratic dimension-naming hint (A1) | `hand_over.ts:96-98` | P0 | none |
| 2 | Fix stale `justification` field (B1, Socratic wording) | `MYCC.md:587` | P2 | none |
| 3 | tmux nesting self-check (P1-1) | `hand_over.ts` ~99 | P1 | none |
| 4 | **P0-2 reproduction** (spawn test session, isolate capture defect) | — | P0 | none |
| 5 | **P0-2 fix** (adjust capture call based on step 4 findings) | `hand_over.ts` ~159/187 | P0 | 4 |
| 6 | `dangerous=i_know` escape param (C1) + Socratic hint (C2) | `bash-judge.ts:44-49` | P1 | none |
| 7 | Observation-skip `INDIRECT_WRAPPERS` (C3) + `EXEC_WRAPPERS` (C4) | `dangerous-commands.ts` | P1 | none |
| 8 | Document `dangerous=i_know` in PARAM docs + MYCC.md (C5) | PARAM doc source, `MYCC.md` | P1 | 6 |
| 9 | Add hand_over usage subsection to MYCC.md (B2/B3, includes P2-2b multi-line note) | `MYCC.md` ~580 | P2 | 1, 2 |
| 10 | Add test cases (see below) | `src/tests/...` | — | 6, 7 |
| 11 | Run full `pnpm test` suite | — | gate | all |

**Rationale:** Steps 1-3 are independent, low-risk, fast wins. Step 4 is research (no code), step 5 depends on its findings. Steps 6-8 form the Cluster C core (escape param + hint + wrapper fixes + docs). Steps 9-10 polish. Step 11 is the regression gate.

---

## Test Plan

**Cluster A (hand_over intent):**
- `RUN USER TO enter sudo password` → accepted (unchanged).
- `READ USER TO ...` → rejected with Socratic verb hint (names "execute a command or process," doesn't say RUN).
- `RUN SYSTEM TO ...` → rejected with Socratic object hint (names "human interacting with a terminal," doesn't say USER).
- Malformed intent → rejected with format reminder.

**Cluster B (P1-1 tmux nesting):**
- Inside tmux, `tmux attach -t foo` → rejected with alternatives 1 & 2, no `unset TMUX`.
- Inside tmux, `tmux -L sock attach -t foo` → rejected (covers `-L` form).
- Inside tmux, `tmux send-keys -t foo 'x' Enter` → NOT rejected (safe from inside tmux).
- Outside tmux, `tmux attach -t foo` → NOT rejected (`$TMUX` unset).

**Cluster C (dangerous escape + wrappers):**
- `sudo mkfs.vfat /dev/sdd1` with `intent="WRITE SYSTEM cmd=mkfs dangerous=i_know TO format"` → user y/N prompt fires.
- `sudo mkfs.vfat /dev/sdd1` with `intent="WRITE SYSTEM cmd=mkfs TO format"` (no `dangerous=i_know`) → Socratic hint (names PARAM override existence, withholds key/value).
- `tmux capture-pane -t mycc-1 -p` (pane contains "mkfs") → allowed (observation-skip).
- `tmux send-keys -t mycc-1 'sudo mkfs.vfat ...' Enter` → blocked unless `dangerous=i_know` present → user y/N.
- `sh -c 'mkfs.vfat /dev/sda1'` → blocked even with `dangerous=i_know` (EXEC_WRAPPER defense — obfuscation bypass attempt).
- `tmux list-sessions` → allowed.

**P0-2 (capture, post-reproduction):** Test cases defined after step 4 isolates the root cause.

---

## Files to Change (consolidated)

- `src/tools/hand_over.ts` — A1 (step 1), P1-1 (step 3), P0-2 fix (step 5)
- `src/context/grant/bash-judge.ts` — C1 + C2 (step 6)
- `src/context/grant/dangerous-commands.ts` — C3 + C4 (step 7)
- `src/context/grant/intent-parser.ts` or wherever PARAM docs are emitted — C5 (step 8, locate during implementation)
- `MYCC.md` — B1 (step 2), C5 (step 8), B2/B3 (step 9)
- `src/tests/tools/bash.test.ts` — Cluster C test cases (step 10)
- `src/tests/tools/hand_over.test.ts` — Cluster A + B test cases (step 10, may need to create)

## Open Research Item (implementation phase only)

**P0-2 root cause reproduction** — no code spec until the Linux `capture-pane` defect is reproduced and isolated. See step 4 candidates A-D above.

## Dropped Items (for the record)

- A2 (PURPOSE-clause soft-accept) — bypasses the reasoning gate.
- A3 (rule in always-on tool desc / `OBJECT_MEANINGS.USER`) — spoon-feeds.
- P0-2a (exit-code marker) — conflicts with human-owned popup (RC ambiguity).
- P0-2b (poll loop) — user answers after watching; redundant.
- P0-2c (default inversion) — user-instructed drop.
- P2-2a (sudo probe) — redundant once P0-2 capture is fixed.
- C6 (`dangerous: boolean` hand_over flag) — conflicts with intent-language pedagogy; `dangerous=i_know` is the sole override channel.