---
name: lfplater-skill-manager
description: >
  Background skill-management workflow for a headless mycc peer launched with
  --role skill-manager. Loaded when the peer receives a [MAIL] note from the
  lfplater-skill-manager timer (or from any lead via mycc-mail). Reviews each
  .mycc/lfplater/ file, searches for existing skills via skill_search, creates
  new skills (via the create-skill workflow) or optimizes existing ones (via
  edit_file), merges duplicated skills conservatively, deletes consumed
  lfplater files, and reports completion back to the sender via mail_to. Runs
  autonomously in --auto mode with no human at the terminal. The timer that
  drives this peer is a standalone Node.js script (timer.js) — it is
  deterministic infrastructure, NOT LLM-driven, so the skill-manager is
  triggered reliably without relying on the LLM's self-identification.
keywords: [skill-manager, lfplater, background, autonomous, headless, hermes,
  skill, create, optimize, merge, review, mail_to, cross-instance, peer,
  closed-learning-loop, timer, periodic, --role]
---

# Skill Manager (Background Peer Workflow)

## Purpose

You are a headless mycc peer spawned with `--role skill-manager` to act as a
skill-manager. Your job: process accumulated `.mycc/lfplater/` files, turning
captured experiences into reusable skills. You run autonomously in `--auto`
mode — no human is at your terminal.

You were triggered by a `[MAIL]` note (from the timer script or from a lead
agent). After processing, you stay alive in WAIT mode, idle until the next
mail arrives — you do NOT exit after one batch.

## Reply Contract

When your work is complete, report results to the sender:

```
mail_to(name="<senderSessionId>/lead", title="skill-manager report",
        content="summary of what you did")
```

The `senderSessionId` is provided in the mail content. Do NOT reply by
writing prose to your terminal — nobody is reading it. Use `mail_to`.

## Workflow

### Step 1: Scan lfplater directory

- List `.mycc/lfplater/` for pending `.md` files.
- If empty: mail the sender "no lfplater files to process" and return to idle.
- If files exist: read each one with `read_file`.

### Step 2: Process each lfplater file

For each file:

1. Extract the captured context: task, outcome, key files, approach,
   pitfalls, suggested skill name, suggested keywords.
2. Use `skill_search` with the suggested keywords to find existing skills.
3. Decide: create new or optimize existing?
   - **Existing relevant skill found**: `skill_load` it, analyze for gaps,
     use `edit_file` to add the new insight/pitfall/example.
   - **No relevant skill**: use the `create-skill` workflow
     (`skill_load(name="create-skill")`) to create a new skill in
     `.mycc/skills/` following its template and quality guidance.
4. After processing, delete the lfplater file (it's consumed).

### Step 3: Merge duplicated skills

After processing all files, scan `.mycc/skills/` for overlapping skills:

- Use `skill_search` with broad keywords to find similar skills.
- If two skills cover the same domain with clear overlap, merge them:
  - Keep the one with better structure/coverage.
  - Use `edit_file` to absorb unique content from the other.
  - Delete the redundant file.
- Be conservative — only merge when duplication is clear and unambiguous.

### Step 4: Report to sender

Mail the sender a summary:

```
mail_to(name="<senderSessionId>/lead", title="skill-manager report",
        content="Processed N lfplater files. Created: X. Optimized: Y.
                Merged: Z. Skipped (trivial): W. Details: ...")
```

Then return to idle (WAIT). The sender (timer or lead) will mail you again
when more lfplater files accumulate. Do NOT exit.

## Guardrails

- **Do not create trivial skills** — if an lfplater file describes routine
  work, skip it and note it in the report.
- **Do not modify source code** — you only touch `.mycc/skills/` and
  `.mycc/lfplater/`.
- **Do not exit after one batch** — stay alive in WAIT for the next mail.
- **Respect existing skill structure** — when optimizing, enhance; do not
  rewrite from scratch.