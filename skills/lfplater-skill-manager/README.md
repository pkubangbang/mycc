# lfplater-skill-manager

A built-in **service skill** that turns accumulated `.mycc/lfplater/` files
into reusable skills autonomously. Run as a daemon via the `--daemon` flag:

```bash
mycc --daemon lfplater-skill-manager --skip-healthcheck
```

The skill declares `service: true` + `service_cron: "*/10 * * * *"` in its
frontmatter, so the daemon Lead self-nudges every 10 minutes (via croner),
scans the lfplater backlog, processes any new files, then idles in WAIT mode
between ticks / external `mail_to` nudges.

## Architecture

```
mycc --daemon lfplater-skill-manager
┌──────────────────────────────────────────────────────────────────┐
│ Daemon Lead (detached, headless, --auto mode, WAIT-polls mail).  │
│                                                                  │
│  croner tick (every 10 min)  ─┐                                  │
│  ───────────────────────────  │                                  │
│   1. append a [Service nudge] mail                                │
│   2. WAIT picks it up → loads this skill                          │
│   3. scans .mycc/lfplater/ → creates/optimizes/merges skills       │
│   4. deletes consumed lfplater files → idle until next tick        │
│                                                                  │
│  Also responds to external mail_to from any peer in the same      │
│  workDir (discovered via peers()).                               │
└──────────────────────────────────────────────────────────────────┘
```

There is no separate operator script and no LLM judgment in the trigger
loop — the croner timer is deterministic infrastructure. This avoids the
LLM overconfidence blind-spot (the agent will not reliably self-identify
the need to spawn a skill-manager). The daemon does the LLM work; croner
just nudges it on a schedule.

## Setup

From the project working directory, start the daemon (it detaches and
returns immediately):

```bash
mycc --daemon lfplater-skill-manager --skip-healthcheck
```

The Coordinator spawns the Lead as a detached background process
(`child.unref()`, no terminal I/O) and exits. The Lead runs headless in
`--auto` mode, registers its identity with `daemon: true` + `role:
lfplater-skill-manager`, stamps its OS PID into the heartbeat file, and
enters WAIT mode. No manual teardown is needed — it stays alive between
ticks and external nudges.

## Dropping lfplater files

The `learn-from-past` hook's "later" branch writes files to
`.mycc/lfplater/`. The daemon picks them up on the next croner tick (or
on an external `mail_to` nudge) and processes them.

## Stopping the daemon

The daemon is a detached process with no terminal. To find and kill it,
use peer discovery — the daemon stamps its OS PID into its heartbeat file,
which the `peers` tool surfaces:

1. From any mycc in the same working directory, run `peers()`.
2. Find the entry with `daemon: true` and `role: lfplater-skill-manager`.
3. Read its `pid: <N> (kill via ...)` line — it gives the platform-specific
   kill command (`taskkill /PID <N>` on Windows, `kill <N>` on Unix).

```bash
# Unix (graceful — lets the Lead run its shutdown handler):
kill <pid>
# Force (immediate; stale heartbeat cleaned by the 1h prune sweep):
kill -9 <pid>

# Windows:
taskkill /PID <pid>       # graceful
taskkill /F /PID <pid>     # force
```

> **Why killing the PID reliably stops the cron:** croner's `Cron` timer
> runs its tick callbacks inside the Lead's event loop, and is created with
> `{ unref: true }` so it never keeps the process alive on its own. There
> is no separate cron process to orphan — killing the Lead PID terminates
> the cron with it.

## How it works (details)

1. **Startup**: `mycc --daemon lfplater-skill-manager` spawns a detached
   Lead. The Lead forces `--auto` mode, dedups against any existing daemon
   with the same role + workDir (via `identity.json` + freshness), auto-
   loads the skill via a system note, and starts the croner timer from the
   skill's `service_cron`. If the skill has no `service_cron`, it runs as a
   *passive* daemon (stays alive, triggered only by external `mail_to`).

2. **Cron tick**: croner fires on the `service_cron` schedule and appends a
   `[Service nudge]` mail. The WAIT state's poll picks it up and routes to
   the LLM, which (having loaded this skill) scans `.mycc/lfplater/`,
   processes files (search/create/optimize/merge skills), deletes consumed
   files, and mails a report back. Then it idles until the next tick.

3. **External nudge**: any peer in the same workDir can `mail_to` the daemon
   (discovered via `peers()`) to trigger an immediate processing pass
   outside the cron schedule.

4. **Discovery**: the daemon registers in `identity.json` with `daemon:
   true` and `role: "lfplater-skill-manager"`, and stamps its PID into its
   heartbeat file. Any lead can find it via `peers()` and read the kill
   target. Stale entries (heartbeat > 1h) are pruned on the next
   `register()` call (prune-on-register logic in `src/peer/identity.ts`).

## Files

| File | Purpose |
|------|---------|
| `SKILL.md` | The workflow the daemon loads on each cron tick / external nudge |
| `README.md` | This file |

## Why a daemon, not an LLM hook?

The original design had the `learn-from-past` hook instruct the lead
agent's LLM to spawn a skill-manager when lfplater files accumulate. This
hit the LLM overconfidence blind-spot (commit `c9c4f7b`): the LLM does not
reliably self-identify the need for such an action. The `--daemon` mode
replaces both the old LLM-spawn path and the earlier `peer-operator.js`
script with a single deterministic mechanism — a croner timer inside a
detached Lead. No LLM judgment is involved in the trigger.