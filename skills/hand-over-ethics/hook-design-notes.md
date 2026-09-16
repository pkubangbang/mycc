# Hook Design Notes (hand-over-ethics)

On-demand reference for the design rationale behind the `hand-over-ethics`
hook. Linked from [SKILL.md](./SKILL.md). Read this only if you need the *why*
behind the gate's design — the *what to do* lives in the backbone.

## Why this fires only once per compaction window

The hook condition is `session.count('skill_load#hand-over-ethics') == 0`.
`session.*` counts are reset by `sequence.clear()`, which is co-called with
`triologue.compact()`. So:

- Before the 1st `hand_over` in the current livelog window → count == 0 →
  **fires** (this load).
- After this load runs → count == 1 → does **not** fire again in the same
  window. Subsequent legitimate hand_overs (passwords, OAuth) proceed without
  interruption.
- After a **compaction** → count resets to 0, the earlier skill_load result is
  submerged in the summary → the next `hand_over` **re-fires**, because the rule
  may have scrolled out of the model's attention.

This is the intended behavior: the gate teaches the rule once, trusts recall
within a window, and re-teaches after compaction submerges it.

## Why the action is `replace`, not `inject_before` or `block`

### Pitfall: `inject_before` instead of `replace`

`inject_before` would prepend a `skill_load` but **still run the `hand_over` in
the same turn** — the popup opens regardless, and the misuse proceeds with the
ethics content sitting unused. `replace` defers the `hand_over` to the next
turn so the re-decision is real. That is why this skill uses `replace`.

### Pitfall: firing every `hand_over`

An unconditional `replace` would defer every legitimate password/OAuth
`hand_over` by one turn. The `session.count(...) == 0` gate caps it at once per
compaction window — legitimate uses after the first proceed normally.

### Pitfall: a `block` action

`block` cannot reliably tell a legit interactive `hand_over` from a misuse by
inspecting `call.args.command` alone (is `vim` interactive? `ssh`? `sudo apt
install`?). It would over-block the very interactive uses `hand_over` exists
for. The deterministic misuses (tmux-prefix, auto-mode) are already hard-blocked
inside the tool. This skill handles the *judgment* misuses pedagogically, not
by a brittle pattern gate.

## Division of labor: tool gate vs skill gate

The `hand_over` tool hard-blocks deterministic misuses (auto-mode, tmux-prefix,
wrong intent verb/object) by pattern — these have an unambiguous signature. The
remaining misuses are *judgment* calls: a non-interactive one-shot, a
wrong-place command, an empty command. No pattern can reliably classify these
(`ssh` is interactive or not depending on args; `vim` is interactive; `sudo
apt install` needs a password but is otherwise one-shot). So the skill teaches
the rule once per compaction window and trusts recall, rather than gating on a
brittle pattern that would over-block the interactive uses `hand_over` exists
for.