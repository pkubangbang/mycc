---
name: learn-from-past
description: >
  Hookish skill that triggers when the agent calls brief with confidence 10
  (100%), indicating a completed task. Suggests capturing successful experience
  into reusable skills. Asks the user three options: yes (search/create/optimize
  skills), no (return to main task), or later (create a deferred lfp file in
  .mycc/lfplater/ for future processing). Guards against false triggers: only
  fires in normal mode (not plan mode), after 5+ total tool calls in the session,
  and when real work tools (edit_file, write_file, or bash) were used in the
  current turn. Use when a task has been completed successfully and the experience
  could be distilled into a reusable skill. The hook uses a message action — the
  weakest, non-blocking hook action that injects a REMINDER note the agent sees
  in its next round. The message is autonomy-supportive (self-determination
  theory), affirms the user's freedom to decline (reactance theory), and frames
  the experience as already-owned value at risk of being lost (endowment effect).
keywords: [learn, past, experience, success, skill, create, optimize, lfp,
  summary, capture, knowledge, distill, brief, confidence, completed,
  reusable, lesson, lfplater, deferred, autonomy, nudge, suggestion, preserve]
when: "after brief is called with confidence 10 (100%), if not in plan mode, total tool calls exceeds 5, and work tools (edit_file, write_file, or bash) were used this turn, suggest the agent to ask the user whether to summarize the successful experience into a reusable skill"
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
- `seq.hasAny(['edit_file', 'write_file', 'bash'])` — real work tools used in the current turn

These guards prevent false triggers from:
- **Plan-mode confidence** ("confident about my plan" is not task completion)
- **Defensive confusion gaming** (confidence=10 reduces confusion index by 2; the LLM may use it just to lower confusion)
- **Premature optimism** (reporting confidence=10 after 1-2 calls)
- **Read-only turns** (only read/grep/recall used — nothing to summarize)

## Action

`message` — the weakest, non-blocking hook action. Injects a REMINDER note into
the conversation that the agent sees in its next round. The message is
autonomy-supportive and affirms the user's freedom to decline.

The injected message instructs the agent to ask the user a 3-way choice:
**yes / no / later**. See the [Hook Message](#hook-message) section below.

## Hook Message

The following message is injected as a REMINDER note:

```
[REMINDER] A task was just reported complete (brief confidence=10). The experience you just built is valuable and already yours — but it's easy to lose once this context moves on.

You may offer the user a quick choice to preserve it. If the work taught something worth reusing, ask the user — briefly — whether to:
1. **yes** — turn this success into a reusable skill (run `skill_load(name="learn-from-past")` for the full workflow)
2. **no** — continue without saving
3. **later** — defer for now; drop a pointer in `.mycc/lfplater/` to revisit later

This is entirely the user's call, and you are free to skip asking — for example if the work was routine, the user is mid-flow, or they've already declined a similar offer. Ask at most once per completed task.
```

## Workflow: When the User Chooses

When the user responds to the 3-way choice, follow the branch below.

### Branch 1: yes — Summarize into a Reusable Skill

The goal is to find, create, or optimize a skill that captures what made this
task successful.

**Step 1: Search for existing skills**

Use `skill_search` with keywords derived from the task domain:

```
skill_search(search="relevant keywords from the task")
```

**Step 2: Decide — create new or optimize existing?**

- **If a relevant skill exists**: Load it with `skill_load`, analyze its content,
  and identify what's missing or could be improved based on this task's
  experience. Use `edit_file` to add the new insight, pitfall, or example.
- **If no relevant skill exists**: Use the `create-skill` skill to create a new
  one. Load it first: `skill_load(name="create-skill")`. Follow its workflow:
  gather requirements, research, select template, write, create in
  `.mycc/skills/`.

**Step 3: Capture the lesson**

The skill should capture:
- **What was the problem** — the task the user asked for
- **What worked** — the approach, tools, or sequence that succeeded
- **Key decisions** — why certain choices were made
- **Pitfalls avoided** — mistakes that were sidestepped
- **Concrete examples** — specific code, commands, or patterns

**Step 4: Verify**

- Ensure the skill has proper frontmatter (name, description, keywords)
- If hookish, ensure the `when` field is clear
- Test that `skill_search` can find it with relevant keywords

### Branch 2: no — Continue Without Saving

Acknowledge the user's choice briefly and return to the main task. Do not
persist the suggestion or revisit it unless the user brings it up.

Example response:
> No problem — continuing with the main task.

### Branch 3: later — Defer to .mycc/lfplater/

Create a markdown file in `.mycc/lfplater/` that captures enough context to
revisit the summary later.

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
> Saved for later — you can find it in `.mycc/lfplater/`. Continuing with the main task.

## lfplater File Format

All deferred summary files live in `.mycc/lfplater/`. Each file is a standalone
markdown document following the template above. To process a deferred file
later:

1. Read the file with `read_file`
2. Follow Branch 1 (yes) using the captured context
3. After creating/updating the skill, optionally delete the lfplater file

## Non-Nagging Guidance

This hook must not feel intrusive. Follow these principles:

- **Ask at most once per completed task** — the `injectedThisMove` dedup in
  `HookExecutor` prevents same-move re-trigger; the message itself instructs
  "ask at most once per completed task."
- **Skip if routine** — if the task was trivial or routine, the agent may skip
  asking (the message explicitly allows this).
- **Respect "no"** — if the user declines, do not re-suggest for the same task.
- **Be brief** — the question to the user should be quick, not a lengthy
  explanation.

## Common Pitfalls

### Pitfall: Triggering on Non-Completion

**Problem**: The LLM uses confidence=10 for reasons other than task completion
(e.g., defensive confusion reduction, premature optimism, plan confidence).

**Solution**: The condition includes three guards (`!seq.isPlanMode()`,
`seq.totalCount() > 5`, `seq.hasAny(['edit_file','write_file','bash'])`) that
filter out these false triggers.

### Pitfall: Over-Suggesting

**Problem**: The hook fires on every brief(10), annoying the user.

**Solution**: The message includes explicit skip conditions ("if the work was
routine, the user is mid-flow, or they've already declined"). The agent should
use judgment, not blindly ask every time.

### Pitfall: Creating Low-Quality Skills

**Problem**: Rushing to create a skill from a trivial task produces noise.

**Solution**: Only create a skill if the experience is genuinely reusable. If
the task was routine, the "no" or "later" branch is more appropriate.

## Verification Checklist

- [ ] Hook condition compiled correctly (trigger=['brief'], 4-part condition)
- [ ] Message action injects the REMINDER note with 3-way choice
- [ ] `yes` branch: skill_search → create or optimize → verify
- [ ] `no` branch: acknowledge and continue
- [ ] `later` branch: lfplater file created with full template
- [ ] False-trigger guards working (plan mode, low count, read-only turns)
- [ ] Non-nagging behavior (ask once, respect "no", skip if routine)