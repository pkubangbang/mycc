# Pattern 5: Peer Review / All-Channel (All-Channel)

**Theory basis:** Bavelas All-Channel; Mintzberg mutual adjustment.

**When to use:** **Complex, creative, or cross-domain** tasks where the best
solution emerges from teammates negotiating with each other — e.g., an
architecture where frontend, backend, and devops must agree on interfaces.
This is the most decentralized topology; use it when cross-pollination is
essential.

## Communication topology — All-Channel (fully connected)

```
      tm-1 —— tm-2
       |  \  /  |
       |   \/   |
       |   /\   |
       |  /  \  |
      tm-3 —— LEAD (informed, not hub)
```

Teammates communicate **laterally** with each other (`mail_to` between
teammates). The lead stays informed but does NOT relay every message — it
monitors via `issue_list` and intervenes only if the team stalls.

## Tool sequence

```
# 1. Create a shared issue (or one per teammate with no blockers)
issue_create(title="Design the system architecture", content="Frontend, backend, devops must agree on interfaces.")

# 2. Spawn teammates with EXPLICIT lateral communication instructions (enforcement template).
#    Lateral communication MUST be instructed or it silently degrades to a Wheel.
tm_create(name="frontend", role="frontend lead", prompt="""
Claim issue #1. Design the frontend contract.
COMMUNICATION RULES (enforced):
- You MUST mail: backend, devops (lateral negotiation required)
- You MAY mail: lead (ONLY for arbitration/impasse)
- Pattern: All-Channel (peers negotiate directly)
- FAILURE MODE: If you do not mail your peers, you are NOT doing All-Channel.
  Mail backend and devops NOW to start negotiation.
Do NOT wait for the lead to relay — talk to your peers.
""")
tm_create(name="backend", role="backend lead", prompt="Claim issue #1. Design the backend API. You MUST mail: frontend, devops. You MAY mail: lead (arbitration only). Communicate laterally. Do NOT route through lead for peer negotiation.")
tm_create(name="devops", role="devops lead", prompt="Claim issue #1. Design the deployment topology. You MUST mail: frontend, backend. You MAY mail: lead (arbitration only). Communicate laterally.")

# 3. Broadcast the kickoff with the shared goal
broadcast(title="Architecture design kickoff", content="Negotiate the interfaces among yourselves. Mail the lead only if you hit an impasse.")

# 4. Let teammates talk to each other. Monitor with issue_list (per Polling Procedure); do NOT tm_await.
issue_list()

# 5. The lead arbitrates impasses (when a teammate mails the lead) and
#    closes the issue once all three agree.
```

## All-Channel Kickoff Verification (run 1 turn after broadcast)

The biggest failure mode of All-Channel is **Silent Wheel degradation**:
teammates default to mailing the lead and cross-pollination never happens.
Instructing lateral communication is necessary but not sufficient — you must
**verify** it actually started. Run this checklist one turn after the
kickoff broadcast:

```
ALL-CHANNEL KICKOFF VERIFICATION (run 1 turn after broadcast):
1. tm_print() — are all teammates 'working' (not 'idle')? Idle teammates
   may not have started lateral communication.
2. Check your mailbox — has at least ONE teammate mailed a peer (not you)?
   - If all mail is to lead only → Silent Wheel degradation detected.
   - Note: the lead has NO automatic visibility into lateral teammate-to-
     teammate mail. The reliable signal is: teammates are 'working' AND
     issue_comment activity is happening AND no teammate has mailed the
     lead with a "waiting on peers" / "who should I talk to" question.
3. If degradation detected: mail EACH teammate individually with their
   specific required peers and the FAILURE MODE line from the template.
4. Re-verify after 1 turn. If lateral mail still not happening, downgrade
   to Wheel with lead-relayed integration (document the downgrade decision).
```

> **Why the lead cannot directly see lateral mail:** `mail_to` writes
> directly to recipient mailbox files with no copy to the lead. The lead's
> only reliable lateral-mail detector is grep of the session triologue files
> (see `enforcement.md`). In practice, watch for the *absence* of impasse
> mail and the *presence* of issue progress — if both hold, lateral
> negotiation is likely working.

## Stall Detection (All-Channel)

```
- After broadcasting the kickoff, call issue_list() once per turn (per Polling Procedure).
- If no issue_comment has been added by ANY teammate for ≥2 consecutive issue_list checks,
  mail ALL teammates: "Status check — have you reached agreement? Reply with your current position."
- If all teammates reply "waiting on [other teammate]," arbitrate by mailing a decision proposal.
- If a teammate mails "impasse" or "deadlock," arbitrate immediately (same turn).
- Use tm_print() to check for teammates stuck in 'idle' — this may indicate broken lateral
  communication (Silent Wheel degradation). If so, re-mail them with explicit peer instructions.
```

## Example

Design a system where frontend, backend, and devops must agree on API
contracts and deployment boundaries. The teammates negotiate directly; the
lead only arbitrates deadlocks.

## Pitfalls

- **Lateral communication must be EXPLICITLY instructed** in each
  `tm_create` prompt — teammates default to talking to the lead, not each
  other. Without instruction, you silently get a Wheel, not an All-Channel.
- **Verify, don't assume** — run the Kickoff Verification checklist one
  turn after broadcast. Silent Wheel degradation is invisible without
  active checking.
- **Higher coordination cost** — use only when the task genuinely needs
  cross-domain synthesis. For simple independent work, use
  Divide-and-Conquer instead.
- **Monitor for stalls** — if teammates mail the lead with an impasse,
  arbitrate promptly; otherwise the team deadlocks.

## See also

- `enforcement.md` — detecting lateral-mail violations via triologue grep.
- `async-principles.md` — the Polling Procedure.
- SKILL.md — the "Choosing a Workflow" table and Phase Transitions.