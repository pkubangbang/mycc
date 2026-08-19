# Async-First Principles

The system prompt mandates an **asynchronous-first** philosophy. These
rules override any impulse to block.

## 1. `tm_await` is a last resort

Prefer `issue_list` to check progress. Use this decision tree:

```
DECISION: Should I call tm_await?
1. Is there other work I can do right now (other issues to integrate, other teammates to mail)?
   YES → do that work instead. Do NOT tm_await.
   NO  → go to step 2.
2. Is the teammate's result required for my NEXT action (not just "eventually")?
   NO  → end my turn and wait for mail. Do NOT tm_await.
   YES → go to step 3.
3. Has the teammate already mailed me their result or closed their issue?
   YES → use the result from mail/issue_list. Do NOT tm_await.
   NO  → tm_await(name="<teammate>", timeout=60) is justified.
```

## 2. `order(name, title, content)` blocks the lead

It combines `mail_to` + `tm_await` and pauses the lead until the teammate
finishes (default 60s timeout). Use this decision procedure:

```
order() vs mail_to DECISION:
- Use order() when: you need to send a task AND get the result in a single step,
  AND you have no other work to do while waiting.
- Use mail_to alone when: you can continue other work while the teammate processes.
- NEVER use order() when there are other independent teammates still running —
  it blocks the lead and freezes all parallel work.
```

## 3. `tm_remove` requires `tm_await` first

Let the teammate finish before removing it. Set `force=true` only for stuck
teammates.

## 4. `broadcast` and `tm_create` are lead-only tools

Teammates cannot spawn peers or broadcast; they use `mail_to` to the lead
(or to each other, if instructed).

## 5. Let teammates work

Spawn, assign, then step back. Collect results via `issue_list` and mail,
not by blocking on every step. Follow the Polling Procedure (in
`enforcement.md`).

## Common Anti-Patterns

- **Treating idle as a stuck state** — a teammate entering `idle` after a
  phase is normal (the between-rounds gap; it polls for new mail / claimable
  issues and resumes on the next mail). Do not nag ("don't idle", "speed
  up") or take over its work to "push things forward" — that wastes your
  turns and disrupts its rhythm.
- **Managing teammate internals (todos)** — a teammate's todos are its own
  work organization; they do not affect its ability to do assigned work. Do
  not instruct it to "skip todos" or treat "no active todos" as a problem —
  focus on whether the task goal is met.
- **Silent Wheel** — intending All-Channel but never instructing lateral
  communication; teammates default to mailing the lead and cross-pollination
  never happens.
- **Serializing parallel work** — calling `tm_await` immediately after
  spawning independent teammates, defeating the purpose of parallelism.
- **Wrong topology for the task** — using a Wheel for a complex creative
  task (starves synthesis) or All-Channel for a trivial independent task
  (wastes coordination cost).
- **Automating past the human** — in Human-in-the-Loop, blocking on a
  teammate while the human waits for their turn.
- **Mail-only assignment** — assigning work via `mail_to` without an issue;
  no visibility, no status tracking. Always pair `issue_create` +
  `issue_claim` with `mail_to`.

## See also

- `enforcement.md` — the Polling Procedure, Claim/Closure/Broadcast rules.
- `troubleshooting.md` — teammate-not-responding, stalled stages.
- SKILL.md — the "Choosing a Workflow" table and Phase Transitions.