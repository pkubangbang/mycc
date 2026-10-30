## Chore 3: Recurring Note-Template Friction Audit

### Background

The agent's behavior is steered as much by **injected prompt templates** as by
its own reasoning. Every system-generated message the agent sees is produced by
a `triologue.note(category, message, hookName?)` call, which stores it as a
`role:'user'` message prefixed `[<CATEGORY>] ` (`src/loop/triologue.ts`). These
templates are easy to write and easy to let rot: wording that grants **unearned
authorization to progress**, fabricated example literals copied verbatim,
failure notes with **no recovery contract**, and HINT notes that **repeat**
because nothing dedupes them.

Because the templates are prose and their failure mode is a slow behavioral
drift (not a crash), they must be **re-audited on a regular cadence**. This is a
recurring chore, not a one-off.

**Cadence:** re-run when the note layer is touched, and otherwise at least once
per major cycle (or before a release). The 2026-10-09 run found 34 frictions
across 28 templates — that is the baseline to improve against.

### Prerequisites

- A clean-ish working tree (audit is read-only; keep it that way).
- The current template inventory. Enumerate every callsite:

```powershell
# All note() callsites in src/ (excludes node_modules via the grep tool)
Select-String -Path src/**/*.ts -Pattern '\.note\(' | Where-Object { $_.Path -notmatch 'node_modules' }
```

```bash
grep -rn --include='*.ts' '\.note(' src | grep -v node_modules
```

Also read the category model and the hardcoded-prefix list (they are easy to
confuse with `note()` categories): `src/types.ts` → `NoteCategory` plus the
"Hardcoded content prefixes (NOT NoteCategory values)" comment block.

### Step 1 — Snapshot the catalogue

Produce a table of every template: `id · callsite file:line · NoteCategory ·
trigger condition · verbatim string`. Group by category (`REMINDER`, `HINT`,
`URGENT`, `SYSTEM`, `MAIL`). Keep this snapshot — the next audit diffs against
it, so **you only report NEW or CHANGED frictions** (never re-list a
steady-state known item; that is the same noise the audit exists to remove).

### Step 2 — Divide and conquer the review (team pattern)

This audit is a natural **divide-and-conquer** fit (`skills/coordination/pattern-divide-conquer.md`):
split the catalogue into 3 balanced groups and give each to one reviewer,
all in parallel, then synthesize.

- **Group A — REMINDER + URGENT** (nudges, steering, uploads, interrupts).
- **Group B — HINT** (confusion hint + skill-discovery hint; also review the
  trigger/filter mechanics, not just the strings).
- **Group C — SYSTEM + MAIL** (state notifications, failures, inter-agent mail).

Each reviewer writes a report to `.mycc/code-review/<date>-REVIEW-<X>.md` with,
per friction: **id, exact friction, file:line evidence, before/after rewrite,
severity**. Create an issues per group (blocked-by nothing), plus a synthesis
issue blocked by all three. Instruct reviewers: **review only, do NOT edit
source.**

### Step 3 — Judge against the six friction patterns

Classify each finding against the known patterns (evolved from the 2026-10-09
run — extend this list as new patterns emerge):

1. **P1 Silent merge** — *(historical; the merge was removed in 99ce493)* a
   note with no `hookName` used to fold into the last user message, destroying
   attribution. Kept as a named pattern to recognize regressions.
2. **P2 Directive welded to payload** — a control directive concatenated with
   unrelated content in one note.
3. **P3 Unearned authorization to progress** — wording that sanctions forward
   motion without re-orientation ("Proceed with your tasks", "Use tools to make
   progress", imperative "Update your todos").
4. **P4 Missing recovery contract** — a failure note that omits what the loop
   does next (retry/backoff/circuit-breaker→idle) and what to change.
5. **P5 WHO-acted ambiguity** — a SYSTEM note fusing a deterministic machine
   action with LLM-authored text, or presenting a self-initiated action passively.
6. **P6 Repetition engine** — no dedupe, or an analyzer blind to its own prior
   output, so the same hint re-fires.

### Step 4 — Verify each finding at source

Do not trust the catalogue blindly: open the cited `file:line` and confirm the
string and the trigger. Line numbers drift; re-grep. Reject a finding if the
friction is already handled elsewhere (record it in a "not-a-problem" section
with the reason — a clean template is a valid audit result).

### Step 5 — Synthesize the proposal

Write `.mycc/code-review/<date>-FIX-PROPOSAL.md`: a ranked friction table, the
cross-cutting patterns, and one `FIX-n` per fix with the **exact before/after
string, file:line, and a risk note**. Include an execution order that clears
HIGH severities first. **Proposal only — apply no edits in the audit run.**

### Verify

- Every `note()` callsite from Step 1 appears in the catalogue (no omissions).
- Every reported friction has a verified `file:line` and a before/after.
- The proposal is ranked and has an execution order.
- The report set is self-consistent: synthesis references only ids present in
  the three review reports.

### Rollback / Recovery

The audit is **read-only** by construction (reports are new files under
`.mycc/code-review/`; no source is edited). If a later implementation run goes
wrong, recover via `git` (`git status` / `git diff` / `git checkout -- <path>`)
— the audit artifacts themselves are throwaway and git-ignored. Keep the audit
and the implementation as **separate passes**: audit → user approval →
implement, so a bad fix never invalidates the findings.

