---
name: coordination
description: >
  Use when forming or managing a team of multiple agents to accomplish a task that benefits from parallel or coordinated work. Provides named workflow patterns (Divide-and-Conquer, Pipeline, Round-Robin, Broadcast, Peer Review, Funnel, Human-in-the-Loop) that define who talks to whom and in what order. Covers when to form a team, choosing a communication topology, spawning teammates, assigning issues, enforcement of communication rules, and async-first principles. Do NOT use for single-agent work, git worktree management, or quick one-off tasks with no parallelism benefit.
keywords: ["team", coordination, workflow, parallel, distribute, delegate, teammate, "multi agent", collaborate, "divide and conquer", pipeline, "round robin", "peer review", funnel, "human in the loop"]
---

# Multi-Agent Coordination Workflows

> **This is a progressive-disclosure skill.** This entry file holds the
> mental model and the decision points; the detailed references are split
> into sibling files in this folder. Read the sections you need below, and
> `read_file` the referenced files when you reach the corresponding step.
>
> Sibling references in this skill:
> - `pattern-divide-conquer.md` — Pattern 1: Wheel topology, tool sequence, example, pitfalls.
> - `pattern-pipeline.md` — Pattern 2: Chain topology, the Pipeline Relay Procedure, example, pitfalls.
> - `pattern-round-robin.md` — Pattern 3: Circle topology (hub-relay cycle), stopping conditions, example, pitfalls.
> - `pattern-broadcast.md` — Pattern 4: Star broadcast, same-input multi-perspective, example, pitfalls.
> - `pattern-peer-review.md` — Pattern 5: All-Channel, lateral enforcement, the post-kickoff verification checklist, stall detection.
> - `pattern-funnel.md` — Pattern 6: Y topology, explorer→integrator→lead routing, how auto-unblock + the integrator mail work together.
> - `pattern-human-loop.md` — Pattern 7: Human as authoritative node, explicit turn protocol.
> - `enforcement.md` — Claim/Closure/Broadcast rules, the Polling Procedure, the Enforcement Checklist, recovery actions, the Communication Constraint Template.
> - `async-principles.md` — The tm_await decision tree, order() guidance, tm_remove rules, anti-patterns.
> - `troubleshooting.md` — Teammate-not-responding, issue-blocked, task-too-complex decomposition.

## Overview

This skill teaches the lead agent how to **plan and communicate** when
forming a team. Rather than a single linear workflow, it presents distinct
**workflow patterns** grounded in organizational behavior theory. Each
pattern **shapes a communication topology** — who talks to whom, through
what channel, in what order — because the structure of communication
determines the quality of the result.

The central principle: **match the communication topology to the task.**
Centralized topologies (Wheel, Chain) are efficient for simple or
sequential work. Decentralized topologies (Circle, All-Channel) produce
better results for complex, creative, or cross-domain work. Choosing the
wrong topology wastes parallelism or starves cross-pollination.

### Theoretical Lens (compact)

Two frameworks anchor the patterns:

- **Mintzberg's Coordination Mechanisms** — mutual adjustment (peers),
  direct supervision (lead), work process standardization (pipeline),
  output standardization (deliverable spec), skill standardization (roles).
- **Bavelas/Leavitt Communication Networks** — Wheel (hub, centralized),
  Chain (linear relay), Y (funnel to one decision), Circle (decentralized
  ring), All-Channel (fully connected, best for complex creative tasks).

**The Centralization–Decentralization Tradeoff:** Centralized networks
(Wheel, Chain) are faster and more efficient for simple/routine tasks but
yield lower-quality output when autonomy is denied. Decentralized networks
(Circle, All-Channel) are slower to coordinate but yield better results on
complex, creative, or novel tasks because information cross-pollinates.
Choose the topology that matches the task's complexity and need for
cross-domain synthesis.

## When to Form a Team

**Form a team when there are 3+ independent subtasks** that can benefit
from parallel work, OR when the task requires distinct expertise (coder,
reviewer, tester, researcher) that maps to separate agents.

**Decision procedure (run this before spawning anyone):**
```
DECISION: Should I form a team?
1. Enumerate candidate subtasks.
2. For each subtask, answer YES/NO: "Does its output depend on another subtask's output?"
   - If ALL are NO → independent → parallelism benefits.
   - If ANY is YES → sequential dependency exists → consider Pipeline instead.
3. If ≥3 independent subtasks OR ≥2 distinct skill roles (e.g., coder + tester) → FORM TEAM.
4. If <3 subtasks AND single skill domain → DO NOT form a team; do it yourself.
```

**Avoid team mode when:**
- Tasks are strictly sequential with no parallelism benefit
- Quick one-off operations that don't justify spawn overhead
- Subtasks share mutable state (e.g., editing the same file) AND the state
  cannot be partitioned by file/module boundary. If state CAN be
  partitioned (different files, different functions), team mode is still
  viable.

## Choosing a Workflow

Match the task to the topology:

| Task shape | Recommended pattern | Topology | Sibling file |
|---|---|---|---|
| 3+ independent slices, lead integrates | Divide-and-Conquer | Wheel | `pattern-divide-conquer.md` |
| Sequential stages, each feeds the next | Pipeline / Chain | Chain | `pattern-pipeline.md` |
| One artifact, iterative refinement by passes | Play-in-Turn / Round-Robin | Circle | `pattern-round-robin.md` |
| Same task, multiple perspectives | Lectural / Broadcast | Star (one-to-many) | `pattern-broadcast.md` |
| Complex, creative, cross-domain negotiation | Peer Review / All-Channel | All-Channel | `pattern-peer-review.md` |
| Multiple explorations → one decision | Funnel / Y | Y | `pattern-funnel.md` |
| Human is a participant | Human-in-the-Loop | Human as node | `pattern-human-loop.md` |

**Heuristic:** Simple/independent → centralize (Wheel, Chain).
Complex/creative/cross-domain → decentralize (Circle, All-Channel).
Convergent decision from parallel inputs → Y.

**Tie-Breaking Rule (if a task matches multiple patterns, apply in this priority):**
```
1. Human-in-the-Loop   — if a human is a participant, this always wins.
2. Pipeline/Chain      — if there are sequential dependencies (blockedBy), this overrides parallel patterns.
3. Funnel/Y            — if multiple explorations converge to one decision.
4. Peer Review/All-Channel — if cross-domain negotiation is required AND no dependencies exist.
5. Divide-and-Conquer  — if 3+ independent slices with no dependencies.
6. Broadcast/Lectural  — if same input, multiple perspectives, no dependencies.
7. Round-Robin/Circle  — if single artifact, iterative refinement.
```

## Phase Transitions — switching topology as the task evolves

Real tasks often need different topologies for different phases. The
patterns above are not mutually exclusive across a task's lifetime — switch
topology when the task's nature changes:

| Transition | From → To | Why |
|---|---|---|
| Design → Implementation | All-Channel (negotiate) → Pipeline (implement in stages) | Negotiation converges to a contract; implementation becomes sequential |
| Exploration → Decision | Divide-and-Conquer (explore slices) → Funnel (integrate) | Parallel exploration yields slices that must converge to one decision |
| Implementation → Review | Pipeline (build) → Broadcast (multi-perspective review) | A built artifact needs the same input reviewed from multiple angles |
| Drafting → Refinement | Divide-and-Conquer (draft sections) → Round-Robin (iterate) | Independent drafts converge into one artifact for iterative polishing |

**Transition procedure:**
```
1. Close all issues from the completed phase.
2. Announce the new topology to remaining teammates via broadcast/mail.
3. Re-state communication constraints using the new pattern's template
   (see the Communication Constraint Template in enforcement.md).
4. Spawn new teammates or reassign existing ones to new issues.
```

The lead is the conductor of transitions: it is the only agent with
`tm_create` and `broadcast`, so only the lead can change the topology
mid-task.

## Communication Path Rules

Each pattern defines **WHO may talk to WHOM**. Enforce the topology:

| Pattern | Topology | Who talks to whom |
|---|---|---|
| Divide-and-Conquer | Wheel | Teammates → lead ONLY. No lateral mail. |
| Pipeline / Chain | Chain | Each teammate → lead (relay). No lateral mail. |
| Play-in-Turn / Circle | Circle | Teammates → lead (conductor passes baton). No lateral mail. |
| Broadcast / Lectural | Star | Lead broadcasts to all; teammates → lead. No lateral mail. |
| Peer Review / All-Channel | All-Channel | Teammates ↔ teammates laterally; lead only arbitrates. **Must be explicitly instructed.** |
| Funnel / Y | Y | Explorers → integrator (NOT lead); integrator → lead. |

**State the communication constraint in every `tm_create` prompt.**
Teammates default to talking to the lead. If your pattern requires lateral
communication (All-Channel) or routing through an integrator (Y), say so
explicitly. Use the Communication Constraint Template in `enforcement.md`.

## Async-First Principles (compact)

The system mandates an **asynchronous-first** philosophy:

1. **`tm_await` is a last resort.** Prefer `issue_list` to check progress.
   The full decision tree is in `async-principles.md`.
2. **`order()` blocks the lead.** Use it only when you have no other work
   and need the result in a single step. NEVER use it when other teammates
   are still running in parallel.
3. **`tm_remove` requires `tm_await` first**; `force=true` only for stuck
   teammates.
4. **`broadcast` and `tm_create` are lead-only.** Teammates use `mail_to`.
5. **Let teammates work.** Spawn, assign, step back. Follow the Polling
   Procedure in `enforcement.md`.

## Enforcement (compact)

`mail_to` has **no access control** — the lead cannot prevent lateral mail,
and has no automatic visibility into it. **Enforcement is reactive (detect
+ correct), not preventive.** The lead monitors via the Enforcement
Checklist (in `enforcement.md`) and corrects violations with recovery
actions. The only reliable lateral-mail detector is grep of the session
triologue files.

## Summary

1. **Match the communication topology to the task** — centralize for
   simple/independent, decentralize for complex/creative. Use the
   Tie-Breaking Rule for multi-match tasks.
2. **State the communication constraint in every `tm_create` prompt** — use
   the Communication Constraint Template (in `enforcement.md`) with
   explicit MAY/MAY NOT mail lists. The topology is only enforced if
   teammates know who they may talk to.
3. **Use issues for all work** — visibility, dependencies, and status
   tracking. Teammates claim and close their own issues (Claim Rule,
   Closure Rule in `enforcement.md`).
4. **Enforcement is reactive** — `mail_to` has no access control; the lead
   detects violations via the Enforcement Checklist and corrects them.
5. **Async-first** — use the `tm_await` decision tree (`async-principles.md`);
   `tm_await`/`order()` are last resorts. Follow the Polling Procedure.
6. **`tm_remove` requires `tm_await` first**; `force=true` only for stuck
   teammates.
7. **When the human is involved, treat them as a first-class participant**
   — define the protocol upfront, hand turns explicitly, never skip their
   turn (`pattern-human-loop.md`).
8. **Phase Transitions** — switch topology when the task's nature changes;
   the lead is the conductor of transitions.