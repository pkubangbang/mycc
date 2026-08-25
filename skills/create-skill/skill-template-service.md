---
name: skill-name
description: >
  Detailed description for RAG search. State WHAT the service does on each
  nudge (the actionable work), not just that it "is a service". Cover the
  domain, the trigger source (cron self-nudge vs external mail_to), and
  related keywords (service, cron, daemon, scheduled, background, headless).

  Example: This service skill scans .mycc/lfplater/ every 10 minutes and
  processes each deferred-learning file into a reusable skill. Use when you
  need a scheduled, headless background worker. Covers: cron nudge handling,
  idempotent file processing, reporting back via mail_to.
  Token limit: < 800 tokens
keywords: [service, cron, daemon, scheduled, background, headless, tag1, tag2]
service: true
service_cron: "0/10 * * * *"
---

# [Skill Name]

## Overview

Brief introduction: what this service does, what triggers it (cron
self-nudge and/or external `mail_to`), and why it runs headless.

> **This is a SERVICE skill.** It runs as a long-lived headless background
> process via `mycc --daemon <skill-name>`. The `service: true` frontmatter
> declares it can be daemonized; `service_cron` drives it on a deterministic
> schedule via self-nudge mail. See the `mycc-self-awareness` skill's
> `daemon-services.md` reference for the full mechanism.

## When to Use a Service Skill (vs a normal skill)

Use a service skill when the work must happen **reliably on a schedule or
on external events, with no human at the terminal** — e.g. periodic
cleanup, deferred-work processing, health checks, polling an external
source. Do NOT use it for one-shot tasks a user triggers interactively; a
normal process skill is better there.

## Trigger Sources

This service can be woken by either:

1. **Cron self-nudge** — every `service_cron` interval, the daemon appends
   a `[Service nudge] Cron tick for '<skill>'.` mail to the lead's mailbox.
   The agent loop's WAIT→COLLECT drains it and the LLM acts on it.
2. **External `mail_to`** — a peer or mediator sends mail; the same
   COLLECT path injects it as a `[MAIL]` note. Use this for on-demand
   requests to a passive daemon (omit `service_cron`).

## On Each Nudge — Do This (the actionable workflow)

> **THE KEY POINT: a service skill must be ACTIONABLE.** The LLM has no
> human to redirect it — every nudge must tell it exactly what to inspect,
> what to do, and how to report. Vague instructions like "be helpful" or
> "maintain the system" produce a daemon that wakes, finds nothing concrete,
> and idles. Spell out the concrete loop below.

When woken (by cron nudge or external mail), follow this loop **in order**.
Stop and idle as soon as a step finds nothing to do — do not invent work.

### Step 1: Check for pending work
Describe the EXACT signal of pending work — a directory to scan, a
mailbox flag, a file glob, a query. Name the path/command.

```bash
# Example: list deferred-work files
ls -1 .mycc/lfplater/ 2>/dev/null
```

If nothing is pending → reply with a one-line "nothing to do" status and
idle. Do NOT proceed.

### Step 2: For each work item, do the action
One concrete action per item. Name the tools to call (`read_file`,
`skill_search`, `edit_file`, `wiki_put`, etc.) and the decision logic.

```typescript
// Example: for each lfplater file, search existing skills, then create or
// optimize, then delete the consumed file.
```

### Step 3: Report the result
State HOW to report back — usually `mail_to` to the sender (for
external-mail triggers) or a `brief` status line (for cron nudges). Be
specific about the recipient and the summary content.

### Step 4: Clean up & idle
Consume the work item (delete/rename the file, clear the flag) so the
next nudge doesn't reprocess it. Then idle until the next trigger.

## Common Pitfalls

### Pitfall 1: Not actionable — "be a service"
**Problem:** The skill says "monitor the system" with no concrete
inspection step. The daemon wakes, has nothing specific to do, and idles
uselessly every tick.
**Solution:** Step 1 must name an exact path/glob/query to check; Step 2
must name exact tools and decision logic. A reader should be able to
execute the loop without further instructions.

### Pitfall 2: Re-processing the same work every nudge
**Problem:** Work items are never consumed, so each cron tick redoes
them — duplicate skills, duplicate reports, wasted tokens.
**Solution:** Step 4 must consume/mark each item (delete the file, set a
flag, move to a `done/` subdir). Make the loop **idempotent**: running it
twice on the same state = running it once.

### Pitfall 3: Blocking on a human
**Problem:** The skill calls a tool that prompts the user (`question`,
interactive `hand_over`). In daemon mode every `question()` auto-replies
with its `onEsc` default — so the prompt is silently skipped, not answered.
**Solution:** A service skill must never depend on human input. Use
sensible defaults and self-contained decision logic.

### Pitfall 4: Forgetting `service_cron` vs passive
**Problem:** Declaring `service: true` but no `service_cron`, then
expecting it to run on a schedule. It never wakes.
**Solution:** Scheduled → include `service_cron`. Event-driven (waits for
`mail_to`) → omit it and document the expected mail trigger in Step 1.

### Pitfall 5: Long-running work that exceeds the cron interval
**Problem:** A nudge starts a 15-min job; the next cron tick fires at
10 min and starts a second concurrent run.
**Solution:** Make each nudge's work short and idempotent (see Pitfall 2),
or have Step 1 check a lock/flag and skip if a run is already in progress.

## Launching & Verifying

```bash
# Start the service daemon (scheduled if service_cron is set)
mycc --daemon <skill-name> --skip-healthcheck

# Verify it's running (look for daemon: true, role: <skill-name>)
# via the peers tool inside another mycc instance, or check the identity:
cat ~/.mycc-store/discovery/identity.json | grep -A2 <skill-name>
```

To stop: kill the daemon's OS PID (the `peers` tool surfaces it; the cron
timer lives inside the Lead's event loop so killing the PID stops the
cron with no orphaned timer).

## Verification Checklist

- [ ] Frontmatter has `service: true` (+ `service_cron` if scheduled)
- [ ] `keywords` include `service, cron, daemon, scheduled, background, headless`
- [ ] Step 1 names an EXACT pending-work signal (path/glob/query) — actionable
- [ ] Step 2 names EXACT tools + decision logic per work item — actionable
- [ ] Step 3 states HOW to report (mail_to recipient / brief)
- [ ] Step 4 consumes each item so the loop is idempotent
- [ ] No dependency on human input (no `question`/`hand_over`)
- [ ] Launched and verified via `mycc --daemon <name>`