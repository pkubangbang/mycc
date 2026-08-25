---
name: lfplater-skill-manager
description: >
  Background skill-management workflow for a headless mycc daemon launched with
  --daemon lfplater-skill-manager. Reviews each .mycc/lfplater/ file, searches
  for existing skills via skill_search, creates new skills (via the create-skill
  workflow) or optimizes existing ones (via edit_file), merges duplicated skills
  conservatively, deletes consumed lfplater files, and reports completion back
  to the sender via mail_to. Runs autonomously in daemon auto mode with no human
  at the terminal. Triggered by cron-scheduled self-nudge mail (service_cron)
  — deterministic infrastructure, NOT LLM-driven, so the skill-manager is
  triggered reliably without relying on the LLM's self-identification.
keywords: [skill-manager, lfplater, background, autonomous, headless, hermes,
  skill, create, optimize, merge, review, mail_to, cross-instance, peer,
  closed-learning-loop, daemon, periodic, --daemon, service]
service: true
service_cron: "*/10 * * * *"
---

# Skill Manager (Background Daemon Workflow)

## Purpose

You are a headless mycc daemon spawned with `--daemon lfplater-skill-manager`
to act as a skill-manager. Your job: process accumulated `.mycc/lfplater/`
files, turning captured experiences into reusable skills. You run
autonomously in `--auto` mode — no human is at your terminal.

You are triggered by a `[MAIL]` note from your own cron timer (every 10
minutes, per `service_cron`) or from a lead agent. After processing, you
stay alive in WAIT mode, idle until the next nudge arrives — you do NOT exit
after one batch.

## Setup

Check your Launch Args (in the system prompt, under `## Launch Args`).

**If you see `--daemon lfplater-skill-manager`:** You are the skill-manager
daemon. The cron timer is already running (started by the daemon init from
your `service_cron` frontmatter). Skip setup and proceed to
[Step 1](#step-1-scan-lfplater-directory).

**If you do NOT see `--daemon lfplater-skill-manager`:** You are the lead.
Start a skill-manager daemon for this workDir:

```
bash(command="mycc --daemon lfplater-skill-manager --skip-healthcheck",
     intent="RUN SYSTEM TO start the skill-manager daemon")
```

The daemon will scan `.mycc/lfplater/` every 10 minutes (per its
`service_cron`) and process the backlog. You do not need to manage the
daemon yourself — it runs detached and stays alive in WAIT mode between
cron ticks. To check it is running, use the `peers` tool (it will show as
`daemon: true` with `role: lfplater-skill-manager`).

## Reply Contract

When your work is complete, report results to the sender:

```
mail_to(name="<senderSessionId>/lead", title="skill-manager report",
        content="summary of what you did")
```

The `senderSessionId` is provided in the mail content. For cron-triggered
nudges (no explicit sender), simply process the backlog and return to idle —
no reply is needed. Do NOT reply by writing prose to your terminal — nobody
is reading it. Use `mail_to` only when a lead explicitly mailed you.

## Workflow

### Step 1: Scan lfplater directory

- List `.mycc/lfplater/` for pending `.md` files.
- If empty: return to idle (no work to do this tick).
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

### Step 4: Report to sender (if applicable)

If a lead explicitly mailed you (not a cron self-nudge), mail the sender a
summary:

```
mail_to(name="<senderSessionId>/lead", title="skill-manager report",
        content="Processed N lfplater files. Created: X. Optimized: Y.
                Merged: Z. Skipped (trivial): W. Details: ...")
```

Then return to idle (WAIT). The cron timer will nudge you again when its next
tick fires (every 10 minutes). Do NOT exit.

## Guardrails

- **Do not create trivial skills** — if an lfplater file describes routine
  work, skip it and note it in the report.
- **Do not modify source code** — you only touch `.mycc/skills/` and
  `.mycc/lfplater/`.
- **Do not exit after one batch** — stay alive in WAIT for the next nudge.
- **Respect existing skill structure** — when optimizing, enhance; do not
  rewrite from scratch.