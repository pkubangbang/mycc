# lfplater-skill-manager

A built-in skill that turns accumulated `.mycc/lfplater/` files into reusable
skills autonomously, using a **deterministic timer** (not LLM-driven spawning)
to trigger a headless `--role skill-manager` peer.

## Architecture

```
timer.js (Node.js, deterministic)        skill-manager peer (mycc --auto --role skill-manager)
┌──────────────────────────────┐         ┌──────────────────────────────────────────────┐
│ Every N min:                 │         │ Stays alive in --auto mode (WAIT-polls mail).│
│  1. Scan .mycc/lfplater/     │  mail   │ Receives [MAIL] → loads this skill →         │
│  2. Find/spawn skill-manager │ ──────> │ scans lfplater → creates/optimizes/merges    │
│  3. Send batch via mycc-mail │         │ skills → deletes consumed files → idle.      │
└──────────────────────────────┘         └──────────────────────────────────────────────┘
```

The timer is plain Node.js — no LLM judgment in the trigger loop. This avoids
the LLM overconfidence blind-spot (the agent will not reliably self-identify
the need to spawn a skill-manager). The peer does the LLM work; the timer
just delivers work to it.

## Setup

### 1. Start the timer

From the project working directory:

```bash
# Foreground (for testing):
node skills/lfplater-skill-manager/timer.js

# As a background task (from inside mycc):
bg_create(command="node skills/lfplater-skill-manager/timer.js")

# As a system cron job (every 10 min):
*/10 * * * * cd /path/to/project && node skills/lfplater-skill-manager/timer.js
```

> **Note:** The timer self-terminates after 3 consecutive ticks with no fresh
> lead in `identity.json` for this working directory (the "orphan checker").
> At the default 10-min interval, that's a 30-min grace period — enough for a
> lead restart, but short enough that a dead lead's timer won't run forever.

### 2. Drop lfplater files

The `learn-from-past` hook's "later" branch writes files to `.mycc/lfplater/`.
The timer picks them up on the next tick and mails the skill-manager peer to
process them.

### 3. The peer is spawned automatically

The timer spawns `mycc --auto --role skill-manager --skip-healthcheck` if no
fresh skill-manager peer is found in `identity.json`. The peer stays alive
between batches — no teardown needed.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MYCC_SKILL_MANAGER_INTERVAL_MIN` | `10` | Timer poll interval in minutes |
| `MYCC_SKILL_MANAGER_ROLE` | `skill-manager` | Role label to match in identity.json |

## Stopping

bg_create tasks survive lead death (detached + unref). The timer and peer
write PID files so they can be killed even after the lead is gone:

```bash
# Stop the timer:
kill "$(cat .mycc/lfplater-skill-manager-timer.pid)"
# On Windows:
# taskkill /F /PID "$(Get-Content .mycc/lfplater-skill-manager-timer.pid)"

# Stop the peer:
kill "$(cat .mycc/lfplater-skill-manager-peer.pid)"
# On Windows:
# taskkill /F /PID "$(Get-Content .mycc/lfplater-skill-manager-peer.pid)"
```

If the PID file is missing (e.g. the timer was started before PID-file support),
find the process manually:

```bash
# Unix:
ps aux | grep 'lfplater-skill-manager/timer.js'
ps aux | grep 'mycc --auto --role skill-manager'

# Windows:
Get-Process node | Where-Object { $_.Path -like '*mycc*' }
```

## How it works (details)

1. **Timer** (`timer.js`): periodically scans `.mycc/lfplater/`. If files
   exist, it finds a skill-manager peer in `identity.json` (matching
   `role == "skill-manager"` && `workDir == cwd` && fresh heartbeat). If none
   is fresh, it spawns one and waits for registration. Then it sends a batch
   mail via the `mycc-mail` CLI.

2. **Peer** (`mycc --auto --role skill-manager`): runs in auto mode, WAIT-
   polling for mail. On receiving the `[MAIL]` note, it loads this skill
   (`skill_load(name="lfplater-skill-manager")`), processes the lfplater
   files (search/create/optimize/merge skills), deletes consumed files, and
   mails a report back. Then it idles for the next batch.

3. **Discovery**: the peer registers in `identity.json` with
   `role: "skill-manager"`. Any lead (or the timer) can find it via
   `peers()` or `mycc-mail --list`. Stale peer entries (heartbeat > 1h) are
   pruned on the next register() call (the prune-on-register logic in
   `src/peer/identity.ts`).

## Files

| File | Purpose |
|------|---------|
| `SKILL.md` | The workflow the peer loads on receiving mail |
| `timer.js` | The deterministic periodic trigger (standalone Node.js) |
| `README.md` | This file |

## Why a timer, not an LLM hook?

The original design had the `learn-from-past` hook instruct the lead agent's
LLM to spawn a skill-manager when lfplater files accumulate. This hit the
LLM overconfidence blind-spot (commit `c9c4f7b`): the LLM does not reliably
self-identify the need for such an action. The timer replaces that with
deterministic infrastructure — no LLM judgment is involved in the trigger.