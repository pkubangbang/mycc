# Pattern 1: Divide-and-Conquer (Wheel)

**Theory basis:** Mintzberg output standardization + direct supervision; Bavelas Wheel.

**When to use:** A task splits into 3+ **independent** subtasks with no dependencies. Each teammate works on a separate slice; the lead integrates.

## Communication topology — Wheel (centralized)

```
        teammate-1
            |
teammate-2 — LEAD — teammate-3
            |
        teammate-4
```

The lead is the hub. **Teammates do NOT talk to each other.** All
communication flows through the lead. Each teammate reports progress to the
lead; the lead relays integration results back.

## Tool sequence

```
# 1. Create independent issues (NO blockedBy — they are independent)
issue_create(title="Slice A", content="...acceptance criteria...")
issue_create(title="Slice B", content="...")
issue_create(title="Slice C", content="...")

# 2. Spawn teammates — one per slice, state the communication constraint
tm_create(name="a", role="developer", prompt="""
Claim issue #1. Work ONLY on slice A.
COMMUNICATION RULES (enforced):
- You MAY mail: lead
- You MAY NOT mail: teammate-b, teammate-c (lateral mail is forbidden)
- Pattern: Wheel (all communication through the lead hub)
Report results to the lead via mail_to. Close your issue when done.
""")
tm_create(name="b", role="developer", prompt="Claim issue #2. Work ONLY on slice B. MAY mail: lead. MAY NOT mail: a, c. Report to lead. Close issue when done.")
tm_create(name="c", role="developer", prompt="Claim issue #3. Work ONLY on slice C. MAY mail: lead. MAY NOT mail: a, b. Report to lead. Close issue when done.")

# 3. Kick off all teammates (async — do NOT tm_await yet)
mail_to(name="a", title="Start slice A", content="...")
mail_to(name="b", title="Start slice B", content="...")
mail_to(name="c", title="Start slice C", content="...")

# 4. Teammates claim their own issues (per the Claim Rule). Do NOT pre-claim for them.
#    After they claim, verify ownership with issue_list:
issue_list()  # confirm owner=a for #1, owner=b for #2, owner=c for #3

# 5. Let them work asynchronously. Follow the Polling Procedure: call issue_list()
#    after each unit of your own work, not in a tight loop. End your turn if all
#    in_progress and you have no other work — wait for mail.

# 6. Only when you need results to proceed, collect (tm_await as last resort —
#    see the tm_await Decision Tree in async-principles.md).
#    OR simply wait for mail from teammates and check issue_list.

# 7. Teammates close their own issues (per the Closure Rule):
#    teammate a: issue_close(id=1, status="completed", comment="...", poster="a")
#    teammate b: issue_close(id=2, status="completed", comment="...", poster="b")
#    teammate c: issue_close(id=3, status="completed", comment="...", poster="c")
```

## Example

Research a codebase — teammate A maps the data layer, B maps the API layer,
C maps the UI layer. Each reports findings to the lead; the lead synthesizes
the architecture overview.

## Pitfalls

- **Do NOT `tm_await` immediately after spawning** — that serializes parallel
  work. Let teammates run; check `issue_list`.
- **Do NOT allow lateral communication** — if teammates start mailing each
  other, you no longer have a Wheel and integration gets messy.
- **Define clear acceptance criteria** (output standardization) so each slice
  integrates cleanly.

## See also

- `async-principles.md` — the tm_await decision tree and Polling Procedure.
- `enforcement.md` — how to detect and correct lateral-mail violations.
- SKILL.md — the "Choosing a Workflow" table and Tie-Breaking Rule.