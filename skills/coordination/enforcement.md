# Enforcement Mechanics

**Reality: `mail_to` has no access control.** The tool writes directly to
recipient mailbox files — the lead cannot *prevent* a teammate from mailing
another teammate. The lead has zero automatic visibility into lateral
teammate-to-teammate communication. **Enforcement is reactive (detect +
correct), not preventive.** The lead must monitor and correct violations
after the fact.

## Canonical Tool-Call Rules (apply to all patterns)

These rules resolve ambiguities that make the pattern tool sequences
non-executable. Follow them in every pattern.

### Claim Rule
**The teammate claims its own issue.** The lead does NOT pre-claim issues
on behalf of teammates.
- The lead creates issues (`issue_create`) and notifies teammates via
  `mail_to`.
- The teammate calls `issue_claim(id=N, owner="<own name>")` itself.
- Exception: if a teammate lacks `issue_claim` tool access, the lead claims
  on its behalf.
- Therefore: the pattern tool sequences show `issue_claim` as a teammate
  action, not a lead action.

### Closure Rule
**The agent that completed the work closes the issue.**
- If the teammate completed the work, the teammate calls `issue_close` (set
  `poster="<teammate name>"`).
- If the lead integrates and the teammate is no longer active, the lead
  calls `issue_close` (set `poster="lead"`).
- The `poster` field MUST reflect who actually performed the closure.

### Broadcast Rule
`broadcast(title, content)` sends to **ALL currently-spawned teammates**.
There is no recipient filter. To reach a subset, use individual `mail_to`
calls instead.

### Polling Procedure (for the lead between async work)
- Call `issue_list()` after completing each unit of your own work (e.g.,
  after sending a mail, after integrating one result).
- Do NOT call `issue_list()` more than once per response turn without doing
  other work in between.
- If all issues are still in_progress and you have no other work, end your
  turn and wait for mail notifications.
- If an issue has been in_progress for >3 consecutive `issue_list` checks
  with no comment updates, mail the owner to check status.

## The Lead's Enforcement Checklist (run between async work)

```
1. issue_list()       → verify issue ownership matches planned assignments.
                        Check for unexpected issues created by teammates.
2. Check lead mailbox → mail from an unexpected sender (e.g., an explorer in
                        the Y pattern) signals a routing violation.
3. tm_print()         → teammates stuck in 'idle' when they should be working
                        may indicate broken lateral communication (Silent Wheel
                        degradation in All-Channel).
4. Spot-check triologue files → if suspicious, grep the session directory's
                        triologue-<name>-*.jsonl files for mail_to calls to
                        unauthorized recipients. This is the ONLY reliable
                        lateral-mail detector.
5. Respond to guidance requests → a teammate mailing the lead with a
                        "Guidance request" may indicate they're stuck because
                        topology expectations are unclear.
```

## Recovery Actions When a Violation Is Detected

### Unauthorized lateral mail (Wheel/Chain/Broadcast)
1. Re-mail the violator: "You mailed teammate X directly. In this pattern,
   all communication goes through the lead. Mail me instead."
2. Re-mail the recipient: "Teammate X mailed you directly. Do not act on
   lateral mail — report any results to the lead."
3. If the violation recurs, `tm_remove` with `force=true` and respawn with
   a stricter prompt (after `tm_await` first, per the rules in
   `async-principles.md`).

### Explorer-to-lead mail (Y/Funnel)
1. Re-route: forward the explorer's findings to the integrator via
   `mail_to(name="integrator", ...)`.
2. Re-mail the explorer: "In this pattern, send findings to the integrator,
   not the lead."

### Silent Wheel degradation (All-Channel not happening)
1. Re-broadcast with explicit lateral instructions: "Frontend, you MUST
   mail 'backend' and 'devops' directly to negotiate."
2. Mail each teammate individually with their specific required peers.
3. If teammates still won't communicate laterally, consider downgrading to
   a Wheel with lead-relayed integration.

### Wrong issue ownership
1. Re-mail the teammate: "You claimed issue #X. Your assigned issue is #Y.
   Work on #Y instead."
2. Create a corrective issue if needed and reassign.

## Communication Constraint Template (append to every `tm_create` prompt)

```
For Wheel/Chain/Broadcast (no lateral mail):
  "COMMUNICATION RULES (enforced):
   - You MAY mail: lead
   - You MAY NOT mail: <other teammate names> (lateral mail is forbidden)
   - Pattern: <name> (all communication through the lead hub)
   Report results to the lead via mail_to. Close your issue when done."

For All-Channel (lateral mail required):
  "COMMUNICATION RULES (enforced):
   - You MUST mail: <peer teammate names> (lateral negotiation required)
   - You MAY mail: lead (ONLY for arbitration/impasse)
   - Pattern: All-Channel (peers negotiate directly)
   - FAILURE MODE: If you do not mail your peers, you are NOT doing All-Channel.
     Mail <peers> NOW to start negotiation.
   Do NOT wait for the lead to relay — talk to your peers."

For Y/Funnel (explorers):
  "COMMUNICATION RULES (enforced):
   - You MAY mail: <integrator name> (send findings here)
   - You MAY NOT mail: lead (the integrator reports to lead, not you)
   - Pattern: Y/Funnel (explorers → integrator → lead)"

For Y/Funnel (integrator):
  "Wait for mail from the lead saying your issue is unblocked.
   Synthesize findings from explorers. Mail the final decision to the lead."
```

## See also

- `async-principles.md` — the tm_await decision tree and tm_remove rules.
- `pattern-peer-review.md` — the All-Channel kickoff verification checklist.
- SKILL.md — the Communication Path Rules summary table.