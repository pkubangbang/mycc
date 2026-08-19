# Pattern 3: Play-in-Turn / Round-Robin (Circle)

**Theory basis:** Bavelas Circle; Mintzberg mutual adjustment.

**When to use:** A single artifact needs **iterative refinement** through
repeated passes by different teammates, each improving on the previous
version.

## Communication topology — Circle (hub-relay cycle)

The lead is NOT a peer in the ring — it is the **conductor** who relays the
baton and checks the stopping condition after each pass. The baton passes
sequentially through the teammates, with the lead relaying between each:

```
LEAD → A → (report) → LEAD → B → (report) → LEAD → C → (report) → LEAD
  ↑____________________ cycle repeats ____________________↓
```

Each teammate takes a turn, builds on the previous output, and reports back
to the lead. The lead passes the next teammate the prior pass's output and
evaluates the stopping condition.

## Tool sequence

```
# 1. Create one issue per turn (or reuse a single issue with comments per pass).
#    MANDATORY: write the stopping condition into issue #1's content before pass 1 starts
#    (see Stopping Condition Templates below).
issue_create(title="Pass 1: Draft", content="Stopping condition: <state one template here>.")
issue_create(title="Pass 2: Critique", content="...", blockedBy=[1])
issue_create(title="Pass 3: Revise", content="...", blockedBy=[2])
issue_create(title="Pass 4: Polish", content="...", blockedBy=[3])

# 2. Spawn teammates with distinct roles for each pass (they claim their own issues)
tm_create(name="drafter", role="drafter", prompt="Claim issue #1. Produce a first draft. Close it. Report to lead only.")
tm_create(name="critic", role="critic", prompt="Wait for #2 to unblock. Claim it, critique the draft, list weaknesses. Close it. Report to lead only.")
tm_create(name="reviser", role="reviser", prompt="Wait for #3 to unblock. Claim it, revise per the critique. Close it. Report to lead only.")
tm_create(name="polisher", role="polisher", prompt="Wait for #4 to unblock. Claim it, final polish. Close it. Report to lead only.")

# 3. Start the first turn
mail_to(name="drafter", title="Your turn: draft", content="Claim issue #1 and begin.")

# 4. As each pass closes, the lead relays the output to the NEXT teammate
#    (the lead is the ring conductor — it passes the baton, per the Pipeline Relay Procedure):
#      When issue #1 closes, read its comment, then:
#        mail_to(name="critic", title="Your turn: critique", content="<draft from #1 comment>")
#      When issue #2 closes:
#        mail_to(name="reviser", title="Your turn: revise", content="<critique from #2 comment>")
#      ...and so on.

# 5. Continue around the circle until the stopping condition is met.
#    The lead evaluates the stopping condition after each pass closes.
```

## Stopping Condition Templates (state one before starting the cycle)

```
- Fixed passes:    "We will do exactly N passes. Stop after pass N closes."
- Criterion-based: "Stop when [teammate name] reports 'no changes needed' in their issue comment."
- Lead-judgment:   "After each pass, the lead reviews the artifact against the acceptance
                    criteria in issue #1. If it meets them, the lead stops the cycle and
                    closes all remaining issues."
```

## Example

Write a design doc — draft → critique → revise → polish. Or a code review
cycle: implement → review → fix → verify.

## Pitfalls

- **The lead must relay each turn's output** to the next teammate — the
  Circle does not self-advance; the lead is the conductor (same relay
  mechanism as the Pipeline).
- **Decide the stopping condition upfront** — use one of the Stopping
  Condition Templates above and write it into issue #1's content before pass
  1 starts. Without it, the cycle never ends.
- **Do NOT let teammates jump ahead** — the blocking issue chain enforces
  turn order; respect it.

## See also

- `pattern-pipeline.md` — the relay mechanism this pattern shares.
- `async-principles.md` — the Polling Procedure for monitoring passes.
- SKILL.md — the "Choosing a Workflow" table.