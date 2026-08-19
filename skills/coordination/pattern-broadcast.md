# Pattern 4: Lectural / Broadcast (One-to-Many)

**Theory basis:** Mintzberg direct supervision + skill standardization;
one-to-many communication.

**When to use:** The **same context/task** must be addressed by multiple
teammates simultaneously, each from their own role's perspective. Distinct
from Divide-and-Conquer: here everyone gets the *same* input, not different
slices.

## Communication topology — Star broadcast (one-to-many)

```
            LEAD
           /  |  \
          /   |   \
      tm-1  tm-2  tm-3
```

The lead broadcasts identical context to all teammates at once. Each works
independently with that shared context. Teammates report back to the lead;
they do NOT talk to each other.

## Tool sequence

```
# 1. Create one issue per perspective
issue_create(title="Review PR from security angle", content="...")
issue_create(title="Review PR from performance angle", content="...")
issue_create(title="Review PR from maintainability angle", content="...")

# 2. Spawn teammates with role-based expertise (skill standardization).
#    They claim their own issues per the Claim Rule.
tm_create(name="sec", role="security reviewer", prompt="Claim issue #1. Review the PR for security issues. MAY mail: lead. MAY NOT mail: perf, maint. Report to lead. Close issue when done.")
tm_create(name="perf", role="performance reviewer", prompt="Claim issue #2. Review for performance. MAY mail: lead. MAY NOT mail: sec, maint. Report to lead. Close issue when done.")
tm_create(name="maint", role="maintainability reviewer", prompt="Claim issue #3. Review for maintainability. MAY mail: lead. MAY NOT mail: sec, perf. Report to lead. Close issue when done.")

# 3. BROADCAST the shared context to all teammates at once.
#    broadcast() sends to ALL currently-spawned teammates (no recipient filter — see Broadcast Rule).
broadcast(title="PR #42 review — shared context", content="""
PR #42: <description, diff link, files changed>
Please review from your assigned perspective. Claim your issue, then close it with findings.
""")

# 4. Let all teammates work in parallel (async). Follow the Polling Procedure:
#    call issue_list() after each unit of your own work. End your turn if all in_progress.
issue_list()  # verify ownership: sec=#1, perf=#2, maint=#3

# 5. Collect each teammate's findings (from issue close comments or mail) and synthesize for the user.
```

## Example

"Everyone review this PR from your role's perspective" — security,
performance, and maintainability reviewers all get the same PR and report
back independently.

## Pitfalls

- **`broadcast` is lead-only** — teammates cannot broadcast; they mail_to
  the lead.
- **Broadcast ≠ Divide-and-Conquer** — broadcast sends the *same* task to
  all; divide-and-conquer sends *different* slices. Do not conflate them.
- **Define each teammate's perspective in their `tm_create` prompt** so the
  reviews don't overlap redundantly.

## See also

- `pattern-divide-conquer.md` — the contrast: different slices vs same input.
- SKILL.md — the "Choosing a Workflow" table and Tie-Breaking Rule.