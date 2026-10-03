# Learn-From-Past: Discrepancies Between My Prior Knowledge and mycc's Prompt System

> **Provenance:** written mid-session on 2026-09-30, while coordinating a
> 4-reviewer team on the `mycc-compose` peer-topology feature — a genuinely
> long-horizon task (one compaction + one crash-recovery already happened
> this session). The user's steering note asked: *"with the experience of
> long-horizon task like this one, do you see discrepancy between your
> knowledge and the mycc's prompt system? If so, write learn-from-past docs."*
>
> This doc records cases where my **default, pre-trained instinct** about
> how an agent harness works diverged from how **mycc actually behaves**
> (as documented in `MYCC.md`, `docs/*`, and the skill library). Each entry
> states the instinct, the mycc reality, the evidence, and the correction.

---

## 1. Context compaction is not a lossy amnesia — it is a *directed* summary

**My prior instinct:** when a long task exceeds the context budget, the
harness truncates or summarizes history and the agent "forgets"; recovery
means re-reading the transcript from disk and re-deriving state.

**mycc reality:** compaction is staged and *steering-preserving*:

- The README (`TOKEN_THRESHOLD` section) states the threshold is a **soft
  budget below the model window**, and that on overflow mycc runs an
  **auto-compact** that summarizes history while **preserving
  accomplishments, current state, key decisions, and recent working
  memory**.
- `docs/compact-working-memory.md` names the mechanism: an LLM-stage
  compaction plus a **working-memory focus extraction** — the last thing
  in the summary is an explicit *"Recent Working Memory"* block whose job
  is to carry the active focus across the compaction boundary.
- The compacted session I resumed from is exactly this: it ends with a
  `## WORKING MEMORY EXTRACT` section listing *Immediate task*, *Team
  state*, *Blocked / pending*, *Next steps (in order)*.

**Correction to my instinct:** after a compaction I should **not** re-read
the raw transcript (`.mycc/sessions/.../transcript-lead-*.jsonl`) unless the
summary is provably wrong. The summary's "Next steps (in order)" and
"Blocked / pending" sections are authoritative steering, written by the
harness *for* the post-compaction me. The transcript is the fallback, not
the default.

**Actionable rule:** on resume-after-compaction, execute the summary's
"Next steps" list; only descend to the transcript when a specific fact is
missing or contradicts an observed tool result.

---

## 2. `recap` silently mutates the knowledge tree (the biggest blind spot)

**My prior instinct:** a "compress this exploration span" meta-tool is
*read-only with respect to durable state* — it summarizes and truncates the
in-context span. Any knowledge-base write should be an explicit,
agent-initiated call.

**mycc reality:** `recap` runs **two concurrent LLM forks**
(`handleRecapWithPatch` in `src/loop/checkpoint-recap.ts`): fork #1 writes
the recap summary, fork #2 **independently decides whether to add / update /
delete ONE mindmap node** and, if so, applies it both in memory and to the
append-only `.mycc/mindmap-patch.jsonl`. `src/loop/states/hook.ts` then
prints a small `mindmap-patch: ...` brief. **Nothing in the `recap` tool
result tells the agent the mindmap changed.**

**Evidence:** `skills/mycc-self-awareness/SKILL.md` → "Known Blind Spot:
`recap` can silently update the mindmap"; `docs/mindmap-redesign.md` (Part 2);
`docs/mindmap-usage.md`. The on-disk source of truth for the tree is
`mindmap.json` **plus a replayed patch log**, not `MYCC.md` alone.

**Correction to my instinct:** the mindmap is *not* a pure compile of
`MYCC.md`. A node I "do not remember creating" may be a recap patch. On the
`abandon=true` path the patch fork is skipped (no mutation).

**Actionable rule:** after any `recap`, treat the mindmap as possibly
mutated. If a `recall` result surprises me, check
`.mycc/mindmap-patch.jsonl` before assuming corruption — and never re-add a
node without checking whether a patch already captured it.

---

## 3. `learn-from-past` is a *hook*, not a thing I decide to do

**My prior instinct:** "learn from experience" is a discretionary reflective
step I perform when I judge a task worth capturing.

**mycc reality:** `learn-from-past` is a **built-in hookish skill** with a
compiled condition (`skills/learn-from-past/SKILL.md`):

```
trigger       = ['brief']
condition     = confidence == 10  AND  !isPlanMode()
                AND totalTurns() >= 5
                AND (session.count('edit_file') > 0
                     || session.count('write_file') > 0
                     || session.count('bash') > 0)
action        = message  (injects a REMINDER)
```

It fires on the **`brief` tool with confidence=10**, and its injected
message makes asking the user the binary *"save this as a reusable skill?
(yes / no)"* question **mandatory** — the skill explicitly documents that
the LLM has a *"known blind-spot for self-initiated knowledge capture"* and
tends to illegally self-suppress the question. The `yes` branch writes a
templated doc into `.mycc/lfplater/`; a separate daemon
(`lfplater-skill-manager`) processes it later.

**Correction to my instinct:** (a) knowledge capture is **harness-triggered
at the moment of success**, not self-scheduled; (b) `brief` confidence is a
**structured signal** that arms hooks — not just a status display; (c) when
the REMINDER appears I must **ask the question**, not rationalize it away.

**Meta-note about this very doc:** the user's side task asked me to *write*
a learn-from-past doc directly, which is the `yes`-branch artifact produced
without waiting for the hook. The hook's own guidance is that the *inline*
artifact belongs in `.mycc/lfplater/` for the skill-manager daemon. This
doc deliberately departs from that: it is a **discrepancy analysis**
(reference material for a developer reading `docs/`), not a *"turn this
experience into a skill"* pointer doc. Keeping it in `docs/` — next to its
evidence — makes it reviewable; the lfplater path would have hidden it
inside an async daemon queue.

---

## 4. A pinned todo can *reactivate itself* from context

**My prior instinct:** a todo list is inert state; items are completed by me
and stay completed.

**mycc reality:** pinned todos may carry a **natural-language reactivation
condition**. Per the system prompt, after each nudge cycle the system
evaluates completed pinned todos' conditions against the conversation
context via an LLM and **marks the item back to not-done** when met.
`docs/pinned-todo-reactivation.md` documents the mechanism.

Concretely this session: todo **#15 (commit + PR)** is pinned with
`reactivate: "when the user exits auto mode (or a human is available to
approve a commit) and the … feature has not yet been committed"`. The
`git_commit` was **auto-rejected** because auto mode was ON — so the item
is not merely "pending my action", it is *armed* to wake when a human
appears.

**Correction to my instinct:** a pinned todo is a **standing guard with a
trigger**, not a task I must remember to revisit. Conversely, I must not
retry the gated action (commit) unattended — the pin exists precisely so a
human-gated step is not lost and not force-run.

---

## 5. `git commit` is not mine to run — it is human-gated, and auto mode blocks it

**My prior instinct:** a VCS commit is a routine, agent-executable step in a
task workflow.

**mycc reality:** in this repo the commit path is gated at **two layers**:

1. **Pre-commit hooks** — `test-after-edit` (runs `pnpm test` = typecheck +
   lint + vitest) and `lint-after-edit` (`pnpm lint`) must pass before the
   commit is accepted.
2. **Human approval** — `git_commit` requires user confirmation and is
   **auto-rejected in auto mode** with the message *"auto mode is ON, ask
   the user to exit auto mode (press ESC)"*.

**Correction to my instinct:** "code-complete + green tests" is **not** the
end of the task. The terminal step (commit / PR) belongs to the human. The
correct behavior is: stage, verify, pin the pending commit, and wait — do
**not** retry the commit on a timer or loop.

---

## 6. "Waiting for teammates" must not become polling or nagging

**My prior instinct:** to coordinate teammates, poll their status frequently
and intervene early when a phase looks quiet (idle = possibly stuck).

**mycc reality:** the system prompt is explicit that two normal teammate
behaviors are **not** signals to intervene: (a) an **idle** teammate between
phases (it resumes the instant mail arrives), and (b) a teammate's
**internal todo state** (whether it builds todos is its own business).
Intervene only on a real stall, a timeout, an explicit blocking guidance
request, or an error. And mail is push-based — the recipient drains it on
its next COLLECT; I do not need to poll.

This session's trap: `reviewer-tests` sent *"Guidance request (confusion
index 10) … No active todos"* **twice** while still reporting `working` and
sending progress. That is **not** a stall — the "no active todos" clause is
exactly the internal-todo-state non-signal.

**Correction to my instinct:** prefer `issue_list` / `tm_print` polling over
`tm_await` (async-first), send **no** nag mail for idleness or todo state,
and only intervene on a missed deadline, an error, or a request that
genuinely blocks progress.

---

## 7. The Intent Lang is a *narrow* grammar, not prose with a prefix

**My prior instinct:** annotate a command with a natural-language rationale
("read the file to understand X") and that suffices.

**mycc reality:** the intent grammar is strict —
`VERB OBJECT [PARAM key=value ...] TO PURPOSE`, with a **closed vocabulary**
(7 verbs, 7 objects) and hard lexical rules: one `=` per param, **no spaces
inside a value**, multiple values expressed by **repeating the key**
(`path=a path=b`, never `path=a,b`). Two reserved params (`dangerous=i_know`,
`batch=i_know`) change routing but are *unavailable in child processes* —
a teammate cannot escape a danger gate; only the lead can.

**Correction to my instinct:** the intent string is **machine-parsed and
partially adjudicated by an LLM judge**, not decoration. Vocabulary must
come from the table, and multi-value enumeration repeats keys.

---

## 8. Knowledge retrieval order: local-first, and the mindmap is *compiled*

**My prior instinct:** for "how does this project work?" questions, search
the web or re-derive from source.

**mycc reality:** there is a layered, explicitly ordered knowledge stack —
`recall(path="/")` (mindmap, compiled from `MYCC.md` **plus recap patches**)
→ `skill_search` / `skill_load` (on-demand specialist skills) → `wiki_get`
(persistent RAG, embeddings **always via a local Ollama**) → and only then
`web_search` / `web_fetch` as a last resort. The project context is
**pre-injected** every turn (README, platform/calendar block, environment
reminders), so re-reading it from disk is usually wasted work.

**Correction to my instinct:** start every unfamiliar question at
`recall("/")` / `skill_search`, trust the pre-injected project context, and
treat the web as the fallback it is documented to be.

---

## 9. The session is sealed, and `/load` is not "resume"

**My prior instinct:** a session is a resumable conversation buffer.

**mycc reality:** each start creates a **new UUID**; on process exit the
session is **sealed — a read-only archive that is never written again**.
`/load <id>` (or `mycc --from <id>`) does **not** resume it: it derives a
**brand-new** session by having the LLM *re-understand* the old transcript
and generate a fresh starting context. Loading the same id repeatedly yields
**different** new sessions (variation by re-understanding). Separately,
`--session-id <uuid>` pins the id of a *fresh* session (the sole resume
prerequisite used by the `mycc-compose` feature).

**Correction to my instinct:** "resume" is a re-derivation, not a
continuation; and identity continuity across restarts is achieved with
`--session-id` on a new process, not by reopening the sealed archive.

---

## 10. Shell/tooling assumptions must yield to the environment block

**My prior instinct:** Unix-first instincts (bash, `&&`, forward-slash
paths, `ls`).

**mycc reality:** the harness injects a **Platform & Calendar** block every
session (here: Windows, **pwsh 7**, backslash separator, backtick escape,
forward slashes preferred *in file paths*), plus a **node_modules
exclusion** directive for listing/grep. The `bash` tool's *name* is
historical — on this host it runs pwsh.

**Correction to my instinct:** read the environment block as *binding
configuration*, not as a hint; use `Get-ChildItem`/`Where-Object` idioms,
`;`/`&&` chaining, and never list or grep `node_modules`.

---

## Cross-cutting lesson for long-horizon work

The recurring pattern across all ten entries is the same: **my default
harness model was "stateless tools + my own memory," but mycc is a
*directed* system — it injects context, arms hooks on structured signals
(`brief` confidence, pinned-todo conditions), gates dangerous/terminal
actions (intent grammar, commit approval), and mutates durable state as a
side effect of meta-tools (`recap` → mindmap).**

Practical consequences for a long task like this one:

1. **Trust the injected steering** (working-memory extract, next steps,
   pinned reactivation conditions) over my own reconstruction.
2. **Treat structured signals as triggers**, not decoration — `brief`
   confidence and pinned conditions arm system behavior.
3. **Respect gates** — human approval and danger checks are not obstacles to
   route around (and a teammate *cannot* route around them at all).
4. **Do not manufacture activity** — idle teammates, quiet channels, and
   pending-but-gated steps are normal states, not problems to fix by
   polling, nagging, or force-running.

---

## Sources consulted

- IN USE — `README.md` (`TOKEN_THRESHOLD` / auto-compact / `--daemon` /
  config flags), pre-injected project context.
- IN USE — `skills/learn-from-past/SKILL.md` (hook trigger, condition,
  mandatory gating, `.mycc/lfplater/` workflow).
- IN USE — `skills/mycc-self-awareness/SKILL.md` (glossary; "Known Blind
  Spot: `recap` can silently update the mindmap"; HARD-vs-SOFT Ollama).
- IN USE — `docs/compact-working-memory.md`, `docs/mindmap-redesign.md`
  (Part 2), `docs/mindmap-usage.md`, `docs/pinned-todo-reactivation.md`
  (referenced by the skills above).
- IN USE — system prompt boundaries (teammate idle/todo-state non-signals),
  intent-lang vocabulary tables, Platform & Calendar block.
- NOT RELEVANT — `skills/mycc-self-awareness/{ollama-dependencies,
  launching-and-locating,configuration,io-surfaces,daemon-services}.md`
  (read for glossary accuracy only; not the subject of discrepancies).
- NOT FOUND — an existing `docs/learn-from-past*.md`; none existed, so this
  doc establishes `docs/learn-from-past-discrepancies.md`.
