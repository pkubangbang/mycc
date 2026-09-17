---
name: hand-over-ethics
description: >
  Gate that catches `hand_over` misuse BEFORE an irreversible popup opens —
  when the command needs no human at the TTY (a one-shot read/build/test, an
  ssh one-liner), or belongs on a remote / in another cwd, or was meant to be
  a specific command but came in blank, it redirects you to `bash` (or `bash`
  + `tmux send-keys` for a persistent session) instead. Use this whenever you
  are about to call `hand_over` and want the decision rule and concrete
  misuse examples in context before committing to the popup. Fires once per
  compaction window: it replaces the first `hand_over` call in the window
  with a `skill_load` of itself, so the rule is reviewed before the popup
  opens (session-scoped `skill_load#hand-over-ethics` counter, reset by
  compaction). On Windows the popup is PowerShell 7 (pwsh), so ssh.exe-not-
  on-PATH and the `&` call-operator quirks are covered in the examples below.
keywords: [hand_over, hand-over, ethics, popup, interactive, tty, password, oauth, ssh, remote, tmux, bash, misuse, replace, hook, once, session, compaction, "no human", "wrong place", blank, shell, elevation, pwsh, psmux, windows, cross-platform, redirect, defer]
when: "when hand_over is about to be called for the first time since the last compaction (session.count('skill_load#hand-over-ethics') == 0), replace the hand_over call with a skill_load of this skill so the decision rule and misuse examples are reviewed before the popup opens; do not fire again until a compaction resets the session counter"
---

# Hand-Over Ethics

A gate that fires once per compaction window, `replace`-ing the first
`hand_over` call with a `skill_load` of this skill — so the rule below is
reviewed BEFORE an irreversible popup opens, not narrated alongside it.

## The decision rule

`hand_over` opens a popup terminal that **interrupts the user** and **blocks**
until the human finishes. It is the right tool ONLY when a command **requires
a human at the TTY** and **cannot be driven non-interactively**:

**Legitimate (DO use hand_over):**
- Entering a password the agent must not know: `sudo apt install X`, a sudo
  prompt, an SSH passphrase, an SSH key passphrase.
- OAuth / browser sign-in a human must approve: `ollama` cloud connect
  (waiting for sign-in), a device-flow login.
- An interactive TUI the human drives: `vim file`, `htop`, `less log`,
  `mycc --setup` (the wizard).

**Misuse (DO NOT use hand_over — use bash, or bash+tmux):**
- A **non-interactive one-shot command** — a read/build/test/inspect the agent
  can run itself. The human has nothing to type.
- **Driving a persistent session** (a live SSH shell, a running process) —
  use `bash` with `tmux send-keys` / `capture-pane`. No popup, no interruption.
- **A command that belongs somewhere else** (see Misuse 2 below).

**The tell that hand_over is wrong:** the command needs **no human typing**, OR
the human is **already at a terminal** where the command belongs. In both cases,
reach for `bash` (one-shot) or `bash` + `tmux send-keys` (persistent session).

## Already hard-blocked by the tool (do NOT re-check here)

The `hand_over` tool itself rejects three deterministic misuses up front, so
this skill does not re-check them — if the tool returned an error for one of
these, fix the cause and retry; do not re-issue the same hand_over:

- **Auto mode** — `hand_over` is disabled in `--auto`/`--daemon` mode (no
  interactive terminal). Use `bash` instead, or exit auto mode.
- **Leading `tmux`** — `hand_over` wraps the command in its own tmux session,
  so a leading `tmux` would nest. Pass the INNER interactive command (e.g.
  `ssh`, `vim`, `sudo`), never `tmux ...`. Manage tmux itself via `bash`.
- **Wrong intent verb/object** — the `intent` must be `RUN USER ...`; the tool
  rejects any other verb or object and names the wrong dimension.

This skill handles the **judgment** misuses — the ones no pattern gate can
reliably classify — pedagogically, by surfacing the rule before the popup.

## Concrete misuse examples (anonymized from real sessions)

### Misuse 1 — Non-interactive command via hand_over

**Shape:** the agent used `hand_over` to issue a plain SSH one-liner like
`ssh user@host "uname -a && df -h"` — a read the agent could have run itself
with `bash`. The human had nothing to type; the popup interrupted them for no
reason and blocked until they pressed Enter.

**Correction:** one-shot remote commands go through `bash` (direct `ssh` when
key auth exists). For a *persistent* remote shell you drive across many
commands, use `bash` + `tmux send-keys`/`capture-pane` — non-blocking, no popup.

### Misuse 2 — Wrong-place hand_over (runs locally, not where you think)

**Shape:** the agent needed to run `mycc --setup` (an interactive wizard) on a
**remote** server, but called `hand_over` with `command: "mycc --setup"`.
`hand_over` opens the popup in **this machine's** working directory — so the
wizard ran **locally** (printing help, not the remote wizard), in the wrong
cwd, while the human was already at a live SSH session on the remote.

**Correction:** `hand_over` runs the command in **this** process's cwd, in a
**local** popup. If the command belongs on a remote or in another directory:
- inject it into the **session you already have there** (e.g. `tmux send-keys`
  into the live remote SSH pane), or
- tell the human to run it in their already-open terminal on that host — do
  NOT spawn a local hand_over that executes in the wrong place.

### Misuse 3 — Empty command / pure interactive shell

**Shape:** the agent called `hand_over` with `command: ""` (or omitted it).
`hand_over` opens a bare interactive shell popup with no initial command.
This is legitimate ONLY when you genuinely want to hand the human a blank
terminal; it is a **misuse** when the agent meant to run a specific command
but forgot/omitted it — the popup opens at a plain prompt, the human does not
know what to type, and the turn is wasted.

**Correction:** if you meant a specific command, re-issue the `hand_over` with
that command (or `bash` it if it was non-interactive). Reserve the empty-command
form for the genuine "give the human a terminal" case, and say so in the intent.

## Cross-platform note (Windows)

On Windows, `hand_over` opens a **PowerShell 7 (pwsh)** popup — not cmd or Git
Bash. Two consequences for commands you hand to the human:

- **`ssh.exe` is NOT on pwsh's PATH.** Use the full path
  `C:\Program Files\Git\usr\bin\ssh.exe` (or wherever Git's ssh lives).
- **A quoted exe path alone is a string literal in pwsh, not a command.** The
  call operator `&` is mandatory: `& "C:\Program Files\Git\usr\bin\ssh.exe"
  -o ... user@host`. Without `&`, pwsh throws a ParserError.

`psmux` (a PowerShell-compatible tmux alternative) replaces tmux on Windows for
the bash+tmux fallback paths above. Do NOT misdiagnose a pwsh ParserError as
"hand_over is broken" — read the captured pane; it shows the exact syntax error.

## After this skill loads — re-decision tree

You just got this content because the hook `replace`-d your `hand_over` call.
Resolve to exactly ONE next action — do not hedge:

- **IF the command needs a human at the TTY** (password, OAuth, interactive
  TUI) AND runs in the correct local cwd → **re-issue the `hand_over`**. The
  gate won't fire again this window (count is now 1), so it proceeds cleanly.
- **ELSE IF it was a one-shot read/build/test** → **re-issue via `bash`**.
- **ELSE IF it was meant for a persistent remote session** → **re-issue via
  `bash` + `tmux send-keys`** into the existing session.
- **ELSE IF it belonged on a remote / in another cwd** → do NOT re-issue a
  local `hand_over`. **Inject it into the remote session** (e.g. `tmux
  send-keys` into the live remote SSH pane), or **ask the human to run it
  there**.
- **ELSE IF the command was empty and a specific one was meant** → re-issue
  with the actual command (or `bash` it if it was non-interactive).

The one extra round-trip on the first legitimate hand_over is the price of the
rule actually biting — a `replace` that lets you self-correct before the popup
opens, rather than a powerless nudge narrated alongside the misuse.

---

> **This is a progressive-disclosure skill.** The backbone above is loaded on
> every `skill_load`. The design rationale — why this fires only once per
> compaction window (the `session.count` / `sequence.clear` / `triologue.compact`
> mechanics) and the pitfall reasoning (why `replace` not `inject_before`, why
> once not every time, why not `block`) — is on-demand reference you rarely
> need at decision time.
>
> **[Hook Design Notes](./hook-design-notes.md)** — compaction-window mechanics
> and the three pitfall explanations. read_file it if you need the why behind
> the gate's design.