# Pattern 2: Pipeline / Chain Relay (Chain)

**Theory basis:** Mintzberg work process standardization; Bavelas Chain.

**When to use:** Subtasks are **sequentially dependent** — each stage's output
is the next stage's input. The order is fixed.

## Communication topology — Chain (linear relay)

```
LEAD → A → B → C → LEAD
```

Work flows in one direction. Each teammate receives from the prior stage and
passes to the next. The lead initiates and receives the final result.

## Tool sequence

```
# 1. Create issues with blocking dependencies — the chain
issue_create(title="Stage 1: Design", content="...")
issue_create(title="Stage 2: Implement", content="...", blockedBy=[1])
issue_create(title="Stage 3: Test", content="...", blockedBy=[2])
issue_create(title="Stage 4: Document", content="...", blockedBy=[3])

# 2. Spawn one teammate per stage (teammates claim their own issues per the Claim Rule)
tm_create(name="designer", role="designer", prompt="Claim issue #1. Produce the design. Close it when done; the next stage will pick up. Report to lead only.")
tm_create(name="coder", role="developer", prompt="Wait for issue #2 to unblock. Claim it, implement per the design, close it. Report to lead only.")
tm_create(name="tester", role="tester", prompt="Wait for issue #3 to unblock. Claim it, test the implementation, close it. Report to lead only.")
tm_create(name="writer", role="writer", prompt="Wait for issue #4 to unblock. Claim it, document, close it. Report to lead only.")

# 3. Start the first stage
mail_to(name="designer", title="Start stage 1", content="Claim issue #1 and begin.")

# 4. PIPELINE RELAY PROCEDURE (the lead proactively relays — do NOT wait for teammates to ask):
#    After starting stage N, the lead calls issue_list() each turn (per Polling Procedure).
#    When issue #N shows status="closed", immediately (same turn):
#      a. Read the closing comment (the stage's output/artifact).
#      b. mail_to(name="<next teammate>", title="Stage N done, start stage N+1",
#           content="<stage N output from closing comment>")
#    The blocking issues enforce sequence automatically — when #N closes, #(N+1) unblocks.
#    The teammate for stage N+1 then claims its own issue.
#    Example after stage 1 closes:
#      mail_to(name="coder", title="Stage 1 done, start stage 2", content="<design output>")

# 5. Repeat for each stage. The lead relays each stage's output to the next teammate.

# 6. Collect the final result at the end (the last teammate closes its own issue).
```

## Example

Build a feature — design the API → implement it → write tests → write docs.
Each stage consumes the prior artifact.

## Pitfalls

- **Do NOT `tm_await` between every stage** — blocking issues already
  serialize the work. The lead can do other work while a stage runs; check
  `issue_list` per the Polling Procedure to see which stage is active.
- **Relay the prior stage's output** in the mail to the next teammate — the
  Chain depends on each link passing the artifact forward. Use the Pipeline
  Relay Procedure above.
- **One teammate per stage** — if a stage stalls, the whole pipeline stalls.
  If an issue is in_progress for >3 checks with no comment updates, mail the
  owner (per the Polling Procedure).

## See also

- `async-principles.md` — the Polling Procedure and tm_await decision tree.
- `troubleshooting.md` — handling stalled stages and blocked issues.
- SKILL.md — the "Choosing a Workflow" table and Phase Transitions.