# Pattern 6: Funnel / Y-Pattern (Y)

**Theory basis:** Bavelas Y; multiple inputs converge to a single
decision-maker.

**When to use:** Several independent explorations must **converge into one
decision or synthesis**. Multiple explorers investigate; one integrator
decides.

## Communication topology — Y (funnel)

```
      explorer-1
          \
      explorer-2 → INTEGRATOR → LEAD
          /
      explorer-3
```

Explorers report to the integrator (not directly to the lead). The
integrator synthesizes all findings and reports to the lead.

## Tool sequence

```
# 1. Create explorer issues + one integrator issue blocked by ALL of them
issue_create(title="Explore option A", content="...")
issue_create(title="Explore option B", content="...")
issue_create(title="Explore option C", content="...")
issue_create(title="Synthesize and pick the best approach", content="...", blockedBy=[1,2,3])

# 2. Spawn explorers + one integrator.
#    EXPLORERS mail the integrator, NOT the lead (Y routing — must be explicit).
tm_create(name="exp-a", role="explorer", prompt="Claim issue #1. Investigate option A. COMMUNICATION RULES: You MAY mail: integrator. You MAY NOT mail: lead (the integrator reports to lead, not you). Mail findings to 'integrator'. Close your issue.")
tm_create(name="exp-b", role="explorer", prompt="Claim issue #2. Investigate option B. MAY mail: integrator. MAY NOT mail: lead. Mail findings to 'integrator'. Close your issue.")
tm_create(name="exp-c", role="explorer", prompt="Claim issue #3. Investigate option C. MAY mail: integrator. MAY NOT mail: lead. Mail findings to 'integrator'. Close your issue.")
tm_create(name="integrator", role="integrator", prompt="Wait for mail from the lead saying your issue #4 is unblocked. Then claim it, synthesize all explorer findings, pick the best approach, close #4, and mail the lead the final decision.")

# 3. Kick off explorers (async)
mail_to(name="exp-a", title="Start exploring option A", content="Claim issue #1 and begin.")
mail_to(name="exp-b", title="Start exploring option B", content="Claim issue #2 and begin.")
mail_to(name="exp-c", title="Start exploring option C", content="Claim issue #3 and begin.")

# 4. INTEGRATOR UNBLOCK PROCEDURE (the lead notifies the integrator — do NOT rely on it to poll):
#    The lead monitors issue_list() per the Polling Procedure.
#    When ALL explorer issues (#1, #2, #3) show status="closed", the lead mails the integrator:
#      mail_to(name="integrator", title="Issue #4 is unblocked — begin synthesis",
#        content="All explorer findings are in. Claim issue #4 and synthesize.")
#    The integrator then claims #4, synthesizes, and mails the lead the final decision.
issue_list()
```

## How auto-unblock works (and why the integrator still needs a mail)

The `blockedBy=[1,2,3]` mechanism handles sequencing **automatically**: when
issues #1, #2, and #3 all close, issue #4 becomes claimable on its own — no
manual unblock call is needed. However, **the integrator still needs an
explicit mail notification**, because:

- The integrator was instructed to "wait for mail from the lead saying your
  issue is unblocked." It will **not** poll `issue_list` on its own looking
  for newly-unblocked issues — it is waiting passively.
- Without the mail, the integrator stays idle even though #4 is technically
  claimable, and the funnel stalls at the convergence point.

So the two halves are: **`blockedBy` enforces the sequence automatically**
(the integrator literally cannot claim #4 early); **the lead's mail kicks
the integrator into action** once the sequence gate opens. Both are
required.

## Example

Three researchers explore different solution approaches; one integrator
evaluates all three and picks the best, reporting the decision to the lead.

## Pitfalls

- **Explorers mail the integrator, NOT the lead** — the Y topology routes
  through the integrator. If explorers mail the lead, you have a Wheel, not
  a Y.
- **The integrator must wait for ALL explorers** — use `blockedBy=[all
  explorer ids]` so it only starts once all findings are in.
- **Mail the integrator when unblocked** — `blockedBy` opens the gate
  automatically, but the integrator won't start without a notification
  mail. Do not assume it will poll.
- **Do NOT `tm_await` each explorer serially** — let them run in parallel;
  the blocking issue gates the integrator.

## See also

- `enforcement.md` — detecting explorer-to-lead routing violations.
- `async-principles.md` — the Polling Procedure for monitoring explorers.
- SKILL.md — the "Choosing a Workflow" table and Phase Transitions.