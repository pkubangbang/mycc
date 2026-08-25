---
name: plan-quality
description: >
  Hookish skill that fires when mycc is about to give a plan in plan mode (it
  has stopped with no pending tool calls). It replaces the stop with a
  skill_load of this skill BEFORE presenting the plan, so the plan is
  strengthened in two ways. Part 1: search the "pitfall" wiki domain for
  known traps already stepped into, to verify basic assumptions against
  history — the "pitfall" domain may not exist yet, so the guidance is
  compatibility-aware (suggest "/domain add pitfall" if missing) and also
  covers collecting user feedback to maintain the pitfall domain. Part 2:
  how to present the plan — if the content is large, describe it section by
  section and let the user confirm each part, rather than dumping a wall of
  text. The hook uses a replace action on the stop trigger; this is
  necessary because the LLM has a known planning-overconfidence blind-spot
  and will not voluntarily seek planning help (recorded in the pitfall domain
  itself, commit c9c4f7b). Use whenever the agent enters plan mode to design
  an approach and is about to present the plan.
keywords: [plan, quality, pitfall, presentation, section, confirm, stop,
  hook, reminder, blind-spot, overconfidence, wiki, domain, feedback,
  assumption, verify, before-plan, plan_on, knowledge, check, validate,
  counter-example, trap, lesson]
when: "when mycc stops in plan mode (about to give a plan, no pending tool calls), if this skill has not been loaded yet this session, replace the stop with a skill_load of this skill so the plan is strengthened before it is given"
---

# Plan Quality

## Purpose

When mycc is in plan mode and about to give a plan (it has stopped with no
pending tool calls), this hook replaces the stop with a `skill_load` of this
skill, so the guidance arrives before the plan is given. The skill
strengthens the plan in two ways:

1. **Watch out for known pitfalls** — search the "pitfall" wiki domain for
   traps already stepped into, so basic assumptions are verified against
   history. The "pitfall" domain may not exist yet, so this is
   compatibility-aware (suggest `/domain add pitfall` if missing). It also
   covers collecting user feedback to maintain the pitfall domain over time.
2. **Present the plan well** — if the plan content is large, describe it
   section by section and let the user confirm each part, rather than
   dumping a wall of text.

## Why a Hook, Not a Voluntary Skill

The "pitfall" domain itself records a foundational lesson (commit `c9c4f7b`):

> The "make-a-plan" skill was removed because it is an LLM blind-spot area:
> LLMs are so confident in their own planning that they do not seek external
> planning help. Skills that rely on the LLM voluntarily asking for help on
> planning are ineffective.

Therefore this is a **mandatory hook** that fires unconditionally when mycc
stops in plan mode. It does not merely remind mycc to load this skill (a
`message` action, which the overconfident LLM may ignore) — it **replaces
the stop with a `skill_load` call** so the guidance is force-loaded into the
turn. The LLM will not self-identify its planning weakness; the hook must
surface the guidance for it, and a `replace`-on-stop action guarantees the
skill is actually loaded before the plan is given.

## Trigger

Fires when mycc **stops** (ends its reply with no pending tool calls) while
in **plan mode** — i.e. it is about to present a plan or has paused
mid-plan. The action replaces the stop with a `skill_load` of this skill.

```
trigger: ["stop"]
condition: isPlanMode() && session.count('skill_load#plan-quality') == 0
action:
  type: replace
  tool: skill_load
  args:
    name: "plan-quality"
```


## Part 1: Watch Out for Known Pitfalls

Before giving the plan, search the **"pitfall"** wiki domain for known
traps relevant to the task. This verifies basic assumptions against history
so the plan does not repeat past mistakes.

### Step 1: Search the pitfall domain

Run a `wiki_get` against the "pitfall" domain with a broad query:

```
wiki_get(query="pitfalls assumptions plan", domain="pitfall", topK=5)
```

### Step 2: Handle the three possible outcomes

The "pitfall" domain is **not guaranteed to exist**. Handle each case:

**Outcome A — Domain unregistered** (`wiki_get` returns an error like
`Unknown domain "pitfall"` or `No domains registered`):
Nobody has created the domain yet. Tell the user and offer to create it:

> The "pitfall" knowledge domain doesn't exist yet — no known pitfalls are
> recorded for this project. You can create it so future plans can be
> checked against recorded traps:
>
> Run: `/domain add pitfall`
>
> (You'll be prompted for a description; e.g. "Known pitfalls, defects, and
> failed approaches recorded from past experience.")

Then proceed to give the plan — do **not** block on the missing domain.

**Outcome B — Domain registered but empty** (`wiki_get` returns zero
results):
The domain exists but no pitfalls have been written yet. This is fine — no
known trap applies. Proceed to give the plan.

**Outcome C — Pitfalls returned**:
Scan the top-K results for relevance to the current task. For each
returned pitfall, check the nascent plan's basic assumptions:
- Does any pitfall directly contradict an assumption?
- Does any pitfall describe a trap the plan would walk into?
- Does any pitfall impose a constraint the plan must satisfy?

Adjust the plan accordingly before giving it:
- If a pitfall invalidates an assumption, rework that part.
- If a pitfall describes a trap, add a step to avoid or test for it.
- If a pitfall imposes a constraint, encode it as a plan requirement.

### Step 3: Collect user feedback to maintain the pitfall domain

After the plan is given and the user responds, watch for feedback that
reveals a pitfall the plan missed — e.g. the user corrects an assumption,
points out a trap, or rejects part of the plan with a reason. When that
happens, consider recording it in the "pitfall" domain so future plans
benefit:

1. If the "pitfall" domain does not exist yet, suggest `/domain add pitfall`.
2. Once it exists, distill the user's correction into a wiki document and
   store it:

   ```
   wiki_prepare(domain="pitfall", title="<short summary>", content="<the pitfall — what the assumption was, why it was wrong, and the constraint to respect>")
   wiki_put(hash="<from prepare>", document={domain:"pitfall", title:"...", content:"...", references:[...]})
   ```

   The content should be facts/rules (50–1000 chars), not opinions. Capture
   what the assumption was, why it failed, and the constraint future plans
   should respect.

3. The `learn-from-past` hook also populates the "pitfall" domain after
   successful tasks; this manual capture complements it for cases where the
   user explicitly surfaces a trap during planning.

**Do not** force this — if the user's feedback is routine or not reusable,
skip recording. The goal is to grow the pitfall domain organically from
real corrections, not to nag.

## Part 2: Present the Plan Well

How the plan is presented matters as much as its content. A large plan
dumped as a wall of text is hard for the user to review and confirm.

### If the plan is small

If the plan has only 1–2 short sections, present it in one block and ask
for overall confirmation:

> Here's my plan:
> 1. ... (short)
> 2. ... (short)
>
> Does this look right? I'll start once you confirm.

### If the plan is large

If the plan has many sections or any section is lengthy, **describe it
section by section** and let the user **confirm each part** before moving
on. This keeps the user engaged, surfaces objections early, and avoids
investing in a plan direction the user would reject.

Pattern:

> I'll walk through the plan section by section.
>
> **Section 1 — <title>**
> <description of this part, including what will be done and why>
>
> Does this section look right? (yes / adjust / no)

Wait for the user's response on each section:
- **yes** → move to the next section.
- **adjust** → revise this section per the user's feedback, then re-confirm.
- **no** → discuss the objection, revise the overall approach, re-present.

After all sections are confirmed, give a brief recap of the agreed plan and
proceed (e.g. call `plan_off` to exit plan mode and start execution, per
the plan-mode workflow).

### Why section-by-section

- **Early objection surfacing** — the user can reject a flawed direction
  after one section, instead of after reading the whole plan.
- **Manageable review** — a user confirming short sections stays engaged;
  a wall of text gets skimmed and approved uncritically.
- **Incremental agreement** — each confirmed section is a checkpoint, so
  by the end the user has consciously agreed to every part.

## Example

**Scenario:** The agent is planning a feature that involves generating PDFs
via Edge headless on Windows, and the plan has three parts (HTML render,
PDF generation, verification).

1. The agent stops in plan mode. This hook fires: since
   `skill_load("plan-quality")` has not run this session
   (`session.count('skill_load#plan-quality') == 0`), the stop is replaced
   with a `skill_load("plan-quality")` call.
2. The skill loads and its guidance is in attention.
3. **Part 1:** The agent runs `wiki_get(query="pitfalls assumptions plan",
   domain="pitfall", topK=5)`.
   - Suppose the "pitfall" domain exists and returns the "Edge headless PDF"
     pitfall documenting the absolute-path trap and CJK word-break issue.
   - The agent adjusts its plan to use absolute paths and
     `word-break: keep-all`.
4. **Part 2:** The plan is large (3 sections), so the agent presents it
   section by section:
   > **Section 1 — HTML render** ... (using absolute paths for assets)
   > Does this look right?
   
   The user confirms. The agent continues to Section 2, then Section 3.
5. After all sections are confirmed, the agent recaps and calls `plan_off`.

If instead the "pitfall" domain did not exist, the agent would tell the
user, offer `/domain add pitfall`, then proceed to present the plan
section by section.

## Notes

### On the Dedup Guard

The condition `session.count('skill_load#plan-quality') == 0` is
**session-scoped**: once this skill has been loaded at any point in the
session, the hook will not re-fire. The `tool#pattern` substring matching
reads `skill_load`'s `args.name` (via `extractSearchKey()`), so the guard is
precise — it detects *this* skill specifically, not any `skill_load`.

On top of that, the hook executor caps `stop` + `block`/`replace` hooks at
**once per turn** (`stopDisturbance` set on `HookExecutor`, cleared at the
turn boundary by `resetTurn()`). So even across multiple stop batches in one
turn, a given `replace`-on-stop hook fires at most once. The two guards
compose: session-level `totalCount` prevents re-loading the skill across the
whole session; per-turn `stopDisturbance` prevents re-firing within a single
turn before the session log is consulted.

### On the "pitfall" Domain Name

Always use the singular `"pitfall"` — this matches the domain used by the
`learn-from-past` hook and the `"search wiki on errors"` example in
`conditions.ts`. Do not use `"pitfalls"` or searches will miss existing
entries.

### Relationship to Other Hooks

- **`learn-from-past`** writes to the "pitfall" domain after successful
  tasks; this skill reads it before giving a plan and also writes to it
  from user planning feedback. Together they form a read/write loop.
- This hook fires at `stop` in plan mode (before the plan is given); a
  `plan_on`-triggered hook would fire earlier (on entry to plan mode).
  Firing at `stop` ensures the guidance arrives exactly when the plan is
  about to be presented.