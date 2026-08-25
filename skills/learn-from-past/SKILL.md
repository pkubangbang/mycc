---
name: learn-from-past
description: >
  Hookish skill that triggers when the agent calls brief with confidence 10
  (100%), indicating a completed task. Suggests capturing successful experience
  into a deferred lfplater doc. Asks the user a binary choice: yes (create a
  pointer doc in .mycc/lfplater/ for future processing by the skill-manager
  peer) or no (decline summarizing and continue). Guards against false
  triggers: only fires in normal mode (not plan mode), after 5+ total tool
  calls in the session, and when real work tools (edit_file, write_file, or
  bash) were used at any point in this session (not just the current turn).
  Use when a task has been completed successfully and the experience could be
  distilled into a reusable skill. The hook uses a message action — the
  weakest, non-blocking hook action that injects a REMINDER note the agent
  sees in its next round. The message is autonomy-supportive (self-determination
  theory), affirms the user's freedom to decline (reactance theory), and frames
  the experience as already-owned value at risk of being lost (endowment
  effect).
keywords: [learn, past, experience, success, skill, create, optimize, lfp,
  summary, capture, knowledge, distill, brief, confidence, completed,
  reusable, lesson, lfplater, deferred, autonomy, nudge, suggestion, preserve]
when: "after brief is called with confidence 10 (100%), if not in plan mode, total tool calls exceeds 5, and work tools (edit_file, write_file, or bash) were used at any point in this session, suggest the agent to ask the user whether to summarize the successful experience into a reusable skill"
---

# Learn From Past (LFP)

## Purpose

When the agent completes a task and reports it via `brief` with confidence=10
(100%), this hook suggests the agent offer the user a quick choice to preserve
the successful experience as a reusable skill. Successful experiences are
valuable but easily lost as context moves on — this hook proactively nudges
knowledge capture at the moment of success.

## Trigger

Fires after `brief` is called when ALL of these are true:

- `call.args.confidence == 10` — the agent reported 100% certainty (completed task)
- `!seq.isPlanMode()` — not in plan mode (planning ≠ completing)
- `seq.totalCount() > 5` — at least 5 tool calls this session (real work, not premature optimism)
- `session.count('edit_file') > 0 || session.count('write_file') > 0 || session.count('bash') > 0` — real work tools used at any point in this session (session-scoped, not turn-scoped)

These guards prevent false triggers from:
- **Plan-mode confidence** ("confident about my plan" is not task completion)
- **Defensive confusion gaming** (confidence=10 reduces confusion index by 2; the LLM may use it just to lower confusion)
- **Premature optimism** (reporting confidence=10 after 1-2 calls)
- **Read-only sessions** (only read/grep/recall used — nothing to summarize)

> **Why session-scoped, not turn-scoped:** the confidence=10 brief that marks
> task completion often happens in a turn with NO work tools (e.g. a turn that
> only calls `brief` to report the result of edits made in an *earlier* turn).
> Checking only the current turn would miss these completions. Session-scoped
> counting (`session.count(...)`) persists across turn boundaries, so the hook
> fires whenever real work happened *anywhere* in the session.

## Action

`message` — the weakest, non-blocking hook action. Injects a REMINDER note into
the conversation that the agent sees in its next round. The message is
autonomy-supportive and affirms the user's freedom to decline.

The injected message instructs the agent to ask the user a **binary** choice:
**yes / no**. See the [Hook Message](#hook-message) section below.

## Hook Message

The following message is injected as a REMINDER note:

```
[REMINDER] A task was just reported complete (brief confidence=10). The experience you just built is valuable and already yours — but it's easy to lose once this context moves on.

You MUST offer the user a quick binary choice to preserve it (unless you have already asked for this task, the user recently declined a similar offer, or the work was genuinely trivial/read-only). Ask the user — in ONE line — whether to:
1. **yes** — drop a pointer doc in `.mycc/lfplater/` capturing this success, for the skill-manager peer to process into a reusable skill later
2. **no** — decline summarizing and continue with the main task

Do NOT self-suppress this question with a vague judgment that the work "wasn't worth it." Ask at most once per completed task.
```

## Workflow: When the User Chooses

When the user responds to the binary choice, follow the branch below.

### Branch 1: yes — Defer to .mycc/lfplater/

Create a markdown file in `.mycc/lfplater/` that captures enough context for the
skill-manager peer to process into a reusable skill later. Do NOT create or
optimize a skill inline — that is the skill-manager peer's job, running
asynchronously in the background.

**File naming**: `{timestamp}-{short-task-description}.md`
Example: `2026-07-13-153022-fix-bash-intent-validation.md`

**File template**:

```markdown
# LFP: {one-line task summary}

- **Date**: {ISO timestamp}
- **Task**: {what the user asked for — the original query or goal}
- **Outcome**: {what was accomplished — the successful result}
- **Key files**: {files that were read, edited, or created}
- **Key steps**: {the important steps taken, in order}
- **Approach that worked**: {the strategy or pattern that succeeded}
- **Pitfalls avoided**: {mistakes sidestepped or issues resolved}
- **Suggested skill name**: {a candidate skill name, lowercase-hyphenated}
- **Suggested skill keywords**: {3-5 keywords for skill_search discoverability}
- **Skill type**: {process / reference / lesson / hookish}
- **Notes**: {any additional context for future-you}
```

Create the file using `write_file`:

```
write_file(path=".mycc/lfplater/{timestamp}-{description}.md", content="...")
```

After creating the file, briefly tell the user it's been saved for later and
return to the main task.

Example response:
> Saved for later — you can find it in `.mycc/lfplater/`. The skill-manager will process it into a reusable skill. Continuing with the main task.

### Branch 2: no — Decline Summarizing

Acknowledge the user's choice briefly and return to the main task. Do not
persist the suggestion or revisit it unless the user brings it up.

Example response:
> No problem — continuing with the main task.

## lfplater File Format

All deferred summary files live in `.mycc/lfplater/`. Each file is a standalone
markdown document following the template above. The `lfplater-skill-manager`
daemon (a headless mycc instance launched with
`mycc --daemon lfplater-skill-manager`) processes these files asynchronously:

1. Reads each `.mycc/lfplater/` file
2. Searches for existing skills via `skill_search`
3. Creates new skills (via the `create-skill` workflow) or optimizes existing
   ones (via `edit_file`), merging duplicates conservatively
4. Deletes consumed lfplater files
5. Reports completion back to the sender via `mail_to`

This keeps the knowledge-capture loop closed without interrupting the user's
main-task flow.

## Non-Nagging Guidance

This hook must not feel intrusive. Follow these principles:

- **Ask at most once per completed task** — the `injectedThisMove` dedup in
  `HookExecutor` prevents same-move re-trigger; the message itself instructs
  "ask at most once per completed task."
- **Respect "no"** — if the user declines, do not re-suggest for the same task.
- **Be brief** — the question to the user should be ONE line, not a lengthy
  explanation.

> **Note:** the "skip if routine" latitude is intentionally REMOVED in favor
> of the [Mandatory Gating](#mandatory-gating-the-question-must-be-asked)
> section below. The LLM's judgment of "routine" is unreliable and tends to
> suppress the question entirely. The gating section provides an exhaustive
> list of the ONLY valid skip reasons.

## Common Pitfalls

### Pitfall: Triggering on Non-Completion

**Problem**: The LLM uses confidence=10 for reasons other than task completion
(e.g., defensive confusion reduction, premature optimism, plan confidence).

**Solution**: The condition includes three guards (`!seq.isPlanMode()`,
`seq.totalCount() > 5`, `session.count('edit_file') > 0 || session.count('write_file') > 0 || session.count('bash') > 0`) that
filter out these false triggers.

### Pitfall: Over-Suggesting

**Problem**: The hook fires on every brief(10), annoying the user.

**Solution**: The message includes explicit skip conditions ("if the work was
routine, the user is mid-flow, or they've already declined"). The agent should
use judgment, not blindly ask every time.

### Pitfall: Creating Low-Quality Skills

**Problem**: Rushing to create a skill from a trivial task produces noise.

**Solution**: Only defer to `.mycc/lfplater/` if the experience is genuinely
reusable. If the task was routine, the "no" branch is more appropriate — the
skill-manager peer will not produce a useful skill from a trivial lfplater doc.

## Mandatory Gating: The Question Must Be Asked

The LLM has a known blind-spot for self-initiated knowledge capture: it tends
to silently omit the yes/no question, rationalizing that the task was "routine"
or that asking would interrupt the user's flow. This defeats the entire
purpose of the hook.

**Therefore, when this hook fires, asking the user the binary question is
MANDATORY — not optional.** The only valid reason to skip asking is one of the
explicit skip conditions below. The agent MUST NOT self-suppress the question
based on a vague judgment that the work "wasn't worth it."

### When you MAY skip asking (exhaustive list)

The question may be omitted ONLY when one of these is true:

1. **Already asked for this task** — the `injectedThisMove` dedup in
   `HookExecutor` already prevents same-move re-trigger; if you have already
   asked the user about this specific completion and received an answer, do
   not ask again.
2. **User already declined a similar offer this session** — if the user
   recently said "no" to an LFP prompt for comparable work, respect that and
   skip.
3. **Genuinely trivial / read-only** — the work was a pure lookup, a one-line
   typo fix, or a read-only exploration with no reusable insight. (The trigger
   guards already filter most of these via the session-scoped work-tool check,
   but a borderline case may slip through.)

If NONE of the above apply, you MUST ask the user the binary question (yes /
no). Do not skip it because you feel the user is "mid-flow" — the question
itself is a single line and the user can decline with one keystroke.

### How to ask

Present the binary choice in ONE line, e.g.:

> Want to save this success as a reusable skill? (yes / no)

Do not preface it with a lengthy explanation. Do not bury it in a wall of
text. One line, two options, then act on the answer.

## Verification Checklist

- [ ] Hook condition compiled correctly (trigger=['brief'], 4-part condition)
- [ ] Message action injects the REMINDER note with binary choice (yes / no)
- [ ] `yes` branch: lfplater doc created in `.mycc/lfplater/` with full template
- [ ] `no` branch: acknowledge and continue
- [ ] False-trigger guards working (plan mode, low count, read-only sessions)
- [ ] Non-nagging behavior (ask once, respect "no", skip only per the exhaustive list)
- [ ] **Mandatory gating**: the question is asked unless an explicit skip condition applies — the agent must NOT self-suppress it