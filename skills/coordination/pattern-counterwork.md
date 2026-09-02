# Pattern 8: Counterwork / Debate (Dialectic Convergence)

**Theory basis:** Hegelian dialectic (thesis → antithesis → synthesis);
Mintzberg mutual adjustment under adversarial review; Bavelas All-Channel
with a designated opposition role (Devil's-advocate variant).

**When to use:** The task has **no obviously correct answer** and the best
solution must emerge from teammates **debating and refuting each other's
positions until they converge on consensus**. Distinct from Peer Review
(All-Channel), where peers negotiate complementary interfaces: here
teammates hold **opposing or competing positions** and the goal is to
stress-test ideas through counter-argument, not to agree on a contract.

Examples: choose among competing architectural proposals; resolve a design
trade-off with no clear winner; decide a controversial API shape; pick a
technology when advocates exist on each side.

## Communication topology — Debate ring with a lead-arbitrated convergence

```
   position-A ←──refute──→ position-B
        \                  /
         \   counter-args  /
          \      ↕        /
           LEAD (arbitrates, converges)
```

Teammates are assigned **competing positions**. They argue their position
**and** refute the others (lateral mail between opponents is required, same
as All-Channel). The lead does **not** hold a position — it runs the debate
rounds, detects convergence, and declares consensus.

## The debate procedure (round-based, lead-conducted)

```
COUNTERWORK PROCEDURE:
1. ROUND 1 — POSITION: each teammate mails its position + rationale to its
   opponents AND to the lead.
2. ROUND 2 — REFUTATION: each teammate mails a rebuttal of the opponents'
   positions to them AND to the lead, then revises its own position if
   persuaded.
3. CONVERGENCE CHECK: the lead reads all positions after each round.
   - If positions have converged (teammates agree, or differ only on
     minor points the lead can adjudicate) → declare consensus, stop.
   - If still divergent AND a round limit is not yet hit → run another
     refutation round.
4. SYNTHESIS: the lead writes the consensus (or, on deadlock, makes the
   final call and records the dissenting view).
```

State the **round limit** and the **convergence criterion** BEFORE round 1
(see the Consensus Templates below) — without them the debate never ends.

## Tool sequence

```
# 1. Create one shared issue carrying the question + the stopping rules
issue_create(title="Debate: pick the caching strategy", content="""
Question: should we use Redis, in-process LRU, or no cache?
CONSENSUS RULES:
- Round limit: at most 3 refutation rounds.
- Convergence criterion: teammates agree on ONE option, OR the lead
  adjudicates the remaining differences after round 3.
- Each round: mail your position/rebuttal to your opponents AND the lead.
""")

# 2. Spawn teammates holding COMPETING positions.
#    Lateral mail to opponents is REQUIRED (same enforcement as All-Channel).
tm_create(name="redis-adv", role="redis advocate", prompt="""
Claim issue #1. Argue FOR Redis. COMMUNICATION RULES (enforced):
- You MUST mail: inproc-adv, nocache-adv (refute their positions, defend yours)
- You MAY mail: lead (arbitration/impasse ONLY)
- Pattern: Counterwork/Debate — you hold a competing position; lateral
  refutation is REQUIRED, not optional.
- FAILURE MODE: If you only mail the lead, you are NOT debating. Mail your
  opponents every round.
""")
tm_create(name="inproc-adv", role="in-process advocate", prompt="Claim issue #1. Argue FOR in-process LRU. You MUST mail: redis-adv, nocache-adv. You MAY mail: lead (arbitration only). Lateral refutation required every round.")
tm_create(name="nocache-adv", role="no-cache advocate", prompt="Claim issue #1. Argue FOR no cache (simplicity). You MUST mail: redis-adv, inproc-adv. You MAY mail: lead (arbitration only). Lateral refutation required every round.")

# 3. Kick off round 1
broadcast(title="Debate round 1: state your position", content="Claim issue #1. Mail your position + rationale to BOTH opponents and the lead now.")

# 4. Run the Counterwork Procedure: after each round, read the mail/issue
#    comments, run the Convergence Check, and either declare consensus or
#    broadcast the next refutation round (passing the prior round's positions).
# 5. Synthesize the consensus (or adjudicate on deadlock) and close issue #1.
```

## Consensus Templates (state one before round 1)

```
- Round-limited:   "At most N refutation rounds. The lead adjudicates any
                    remaining divergence after round N and records dissent."
- Criterion-based: "Stop when all teammates explicitly agree on ONE option
                    in their round mail."
- Lead-judgment:   "After each round the lead checks convergence; if two of
                    three teammates have converged, the lead declares
                    consensus and notes the dissenter."
```

## Debate Kickoff Verification (run 1 turn after the round-1 broadcast)

Counterwork shares All-Channel's biggest failure mode — **Silent Wheel
degradation**: teammates mail only the lead and refutation never happens.
Run this one turn after the round-1 broadcast:

```
COUNTERWORK KICKOFF VERIFICATION:
1. tm_print() — are all advocates 'working'?
2. Has at least ONE advocate mailed an opponent (not just the lead)?
   - If all mail is to lead only → Silent Wheel degradation; re-mail each
     advocate with their specific opponents + the FAILURE MODE line.
3. Watch for "I agree with <opponent>" mail early — premature consensus
   before refutation is a separate failure (see Pitfalls).
4. Re-verify after 1 turn; downgrade to lead-adjudicated Wheel if lateral
   debate still won't start.
```

## Example

Three teammates hold competing positions on a caching strategy (Redis vs
in-process vs none). They argue and refute across rounds; the lead detects
when two converge, declares consensus, and records the dissenting view.

## Pitfalls

- **Lateral refutation MUST be explicitly instructed** — without it,
  teammates mail only the lead and you get a Wheel, not a debate (same as
  All-Channel).
- **Premature consensus** — teammates agreeing before refuting defeats the
  purpose. Instruct them to refute FIRST, then revise; the convergence
  criterion should require at least one refutation round.
- **No round limit → infinite debate** — always set a round limit and a
  lead-adjudication fallback; the lead must be willing to break a deadlock.
- **Lead holds a position** — the lead must stay neutral to arbitrate. If
  the lead has a strong prior, assign it to a teammate instead and stay
  out of the argument.
- **Higher coordination cost than Peer Review** — use only when positions
  genuinely conflict. For complementary-interface negotiation, use
  Peer Review (All-Channel) instead.

## See also

- `pattern-peer-review.md` — the lateral-mail topology this builds on;
  Counterwork is the adversarial/convergent variant.
- `enforcement.md` — detecting lateral-mail violations via triologue grep.
- `async-principles.md` — the Polling Procedure for monitoring rounds.
- SKILL.md — the "Choosing a Workflow" table and Tie-Breaking Rule.