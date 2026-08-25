# Daemon Services (`service` / `service_cron` / `--daemon`)

mycc can run a skill as a **long-lived headless background process** — a
"service". This is how background skill-management workflows (e.g. the
built-in `lfplater-skill-manager`) run autonomously and reliably without a
human at the terminal and without relying on the LLM's own
self-identification. This reference documents the three pieces that make it
work: the `service` and `service_cron` frontmatter fields, the `--daemon`
launch flag, and the `daemon-init.ts` bootstrap.

## When this matters (the trigger words)

A user running mycc in **another folder** who says any of these is asking
about the service mechanism — recognize it and use this reference:

- "design a **service** that ..."
- "make this run on a **schedule** / **cron** / periodically"
- "run a skill in the **background** / **headless** / as a **daemon**"
- "trigger the skill-manager reliably without me nudging it"

## The two frontmatter fields

A skill opts into the service mechanism by declaring fields in its YAML
frontmatter (parsed by `src/context/shared/loader.ts` → `reloadSkill`):

```yaml
---
name: my-scheduled-worker
description: Processes deferred work files on a schedule, headless.
keywords: [service, cron, daemon, scheduled]
service: true                 # declares this skill CAN run as a daemon service
service_cron: "0/10 * * * *"  # cron expression for scheduled self-nudge mail
---
```

| Field | Type | Meaning |
|-------|------|---------|
| `service` | `boolean` | Declares the skill CAN be run as a daemon service via `--daemon <name>`. Absent → not a service. |
| `service_cron` | `string` (cron expr) | Cron expression (e.g. `"0/10 * * * *"` = every 10 min) for scheduled **self-nudge mail** when running as a daemon. Absent with `service: true` → **passive daemon** (stays alive, triggered only by external `mail_to`). |

Key points:

- **`service_cron` does NOT call the skill on a timer.** The cron job does
  exactly one thing: it appends a `[Service nudge]` mail to the lead's own
  mailbox (see the data flow below). The agent loop's WAIT→COLLECT then
  drains that mail and the LLM acts on it per the skill's own workflow.
- The cron job is created with `{ unref: true }` so the timer does not keep
  the process alive on its own — the agent loop / heartbeat already do.
- **Only daemon mode activates the cron timer.** A non-daemon lead loading
  a skill with `service_cron` does NOT start cron. This is intentional:
  `--daemon` is the explicit opt-in to scheduled, headless operation.

## Launching: `--daemon [skill]`

From the project directory (or anywhere — the daemon works in any cwd):

```bash
# Passive daemon: no skill, no cron. Stays alive, waits for external mail_to.
mycc --daemon

# Service daemon: auto-loads the named skill; starts its cron timer if it
# declares service_cron.
mycc --daemon lfplater-skill-manager --skip-healthcheck
```

`--daemon` (bare or with a skill) forces the Lead into **daemon mode**:
auto mode ON + no terminal (the Coordinator spawns the Lead detached with
`stdio: 'ignore'`). The Lead returns immediately; the daemon runs in the
background. Find running daemons via the `peers` tool (their
`identity.json` entry has `daemon: true` and `role: <skill-name>`); stop one
by killing its OS PID (the `peers` tool surfaces it — the cron timer lives
inside the Lead's event loop, so killing the PID stops the cron with no
orphaned timer).

## What `daemon-init.ts` does (the bootstrap)

`src/loop/daemon-init.ts` runs once at startup when `--daemon` was passed.
Step by step:

1. **Force auto mode on.** Daemon is always headless auto: the PROMPT stage
   becomes a WAIT stage (block for mail/teammate/steering events instead of
   prompting the user), and every interactive `question()` auto-replies
   with its `onEsc` default so the loop never blocks.
2. **Dedup check (only when a skill name is given).** After peer identity is
   registered, it scans other identities for one with the same `role`
   (skill name) AND same `workDir` that is still fresh (heartbeat within
   90s). If found → fatal error: "A daemon with role 'X' is already running
   for this workDir." It stops the peer subsystem and exits. Bare
   `--daemon` (no skill) does NOT dedup — multiple passive daemons may
   coexist.
3. **Validate + auto-load the skill.** If `--daemon <skill>` names a skill
   that isn't loaded → fatal error and exit. Otherwise it injects a
   `SYSTEM` note telling the LLM to `skill_load(name="<skill>")` on its
   first turn. The WAIT state's 1s poll picks up the note and routes to
   COLLECT → LLM.
4. **Start the cron timer (if `service_cron` exists).** Creates a `Cron`
   job from the skill's `service_cron`. On each tick, the job appends a
   `Service nudge` mail to the lead's mailbox. Returns the job handle so the
   signal handlers can stop it on shutdown. No `service_cron` → logs that
   it's a passive daemon and returns null.

## Data flow: a cron tick → agent action

```
croner timer fires (every N minutes per service_cron)
  │
  ▼
ctx.mail.appendMail('lead', 'Service nudge',
  "[Service nudge] Cron tick for '<skill>'. Check for pending work and
   process it per the skill's workflow.")
  │
  ▼
agent loop WAIT state (1s poll) detects new mail
  │
  ▼
COLLECT drains the mailbox → injects the nudge as a [MAIL] note
  │
  ▼
LLM turn: the LLM sees the nudge, loads/follows the skill's workflow,
does the work (read files, edit skills, mail_to sender, etc.)
  │
  ▼
back to WAIT — until the next cron tick or external mail_to
```

This is **deterministic infrastructure**, not LLM-driven scheduling: the
cron timer is a real OS-level scheduler (`croner`), so the skill is
triggered reliably without depending on the LLM deciding to "check in".
That is the whole point — a self-nudging background service.

## Passive vs scheduled daemon

| Mode | How to get it | What triggers work |
|------|--------------|---------------------|
| **Scheduled** | `service: true` + `service_cron: "..."` + `--daemon <skill>` | The cron timer (self-nudge mail) AND external `mail_to` |
| **Passive** | `--daemon <skill>` where skill has `service: true` but no `service_cron`; OR bare `--daemon` | External `mail_to` only (a peer or mediator pokes it) |

Both stay alive in WAIT mode between triggers; neither needs a human at the
terminal.

## How to design a service skill

1. Write the skill markdown as usual (process/reference/lesson/hookish).
2. Add `service: true` to frontmatter so `--daemon <name>` accepts it.
3. Decide the trigger model:
   - **Scheduled** → add `service_cron: "<cron expr>"`. The skill content
     should describe what to do on each nudge (e.g. "scan `.mycc/lfplater/`,
     process each file, report back via `mail_to`").
   - **Passive (event-driven)** → omit `service_cron`. The skill content
     should describe how to react to incoming `mail_to` (the mail's
     `content` is the trigger payload).
4. Add `service`, `cron`, `daemon`, `scheduled` (and domain terms) to
   `keywords` so `skill_search` surfaces it when a user says "design a
   service that...".
5. Launch with `mycc --daemon <name> --skip-healthcheck` (the
   `--skip-healthcheck` is conventional for fast headless startup).
6. Verify it's running via the `peers` tool (look for `daemon: true`,
   `role: <name>`); stop it by killing its PID.

## Example: the built-in `lfplater-skill-manager`

This is the canonical service skill. It declares `service: true` +
`service_cron` (cron-scheduled self-nudge). On each nudge it reviews every
`.mycc/lfplater/` file, searches for existing skills via `skill_search`,
creates new skills (via the `create-skill` workflow) or optimizes existing
ones (via `edit_file`), merges duplicated skills conservatively, deletes
consumed lfplater files, and reports completion back to the sender via
`mail_to`. It runs autonomously in daemon auto mode with no human at the
terminal. Because the trigger is cron (deterministic infrastructure), the
skill-manager is triggered reliably without relying on the LLM's
self-identification.

## See also

- SKILL.md — the glossary overview (the `service` / `service_cron` /
  `daemon` entries link here).
- `launching-and-locating.md` — `--daemon` among the launch flags.
- `configuration.md` — `--daemon` and related CLI flags.
- `io-surfaces.md` — the daemon is a third "surface": headless, no TUI/WebUI.