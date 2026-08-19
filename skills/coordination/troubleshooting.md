# Troubleshooting

## Teammate Not Responding

- Check `tm_print` — is the process alive (working/idle/shutdown)?
  - **`idle` alone is NOT a problem.** After a teammate finishes a phase it
    enters idle (the normal between-rounds gap; it polls for new mail /
    claimable issues and resumes on the next mail). Only treat idle as a
    stall if it persists past the teammate's deadline (see its Time Budget)
    or coincides with an unanswered guidance request.
- Mail the teammate to check status using this template:
  ```
  mail_to(name="<teammate>", title="Status check", content="""
  Are you still working on issue #N? Reply with:
  - Current status (in progress / blocked / done)
  - What you're doing right now
  - Any blockers you've hit
  """)
  ```
- Use `tm_await` with a timeout as a last resort (per the decision tree in
  `async-principles.md`).
- If stuck, `tm_remove` with `force=true` (after attempting `tm_await`).

## Issue Blocked

- Check `issue_list` to see which issue is blocking and its status.
- Wait for the blocking issue to close — closing a blocker automatically
  unblocks dependents.
- If the blocker's owner is stuck, mail them or reassign.

## Task Too Complex

Decompose into smaller subtasks using this procedure:

```
DECOMPOSITION PROCEDURE:
1. Identify the task's deliverable (what artifact is produced?).
2. If the deliverable has natural boundaries (files, modules, layers), split along those.
3. If not, split by phase (design → implement → test → document).
4. For each split piece, check: can it be done independently?
   - If yes → independent issue.
   - If no  → add blockedBy to the issue it depends on.
5. Assign each piece to the matching pattern using the "Choosing a Workflow" table
   and the Tie-Breaking Rule in SKILL.md.
```

## See also

- `async-principles.md` — the tm_await decision tree and anti-patterns.
- `enforcement.md` — the Polling Procedure and recovery actions.
- SKILL.md — the "Choosing a Workflow" table and Phase Transitions.