---
name: coordination
description: >
  Use when forming or managing a team of multiple agents to accomplish a
  task that benefits from parallel or coordinated work. Provides named
  workflow patterns (Divide-and-Conquer, Pipeline, Round-Robin, Broadcast,
  Peer Review, Funnel, Human-in-the-Loop) that define who talks to whom
  and in what order. Covers when to form a team, choosing a communication
  topology, spawning teammates, assigning issues, enforcement of
  communication rules, and async-first principles. Do NOT use for
  single-agent work, git worktree management, or quick one-off tasks
  with no parallelism benefit.
keywords: [team, coordination, workflow, parallel, distribute, delegate, teammate, "multi agent", collaborate, "divide and conquer", pipeline, "round robin", "peer review", funnel, "human in the loop"]
---

# Multi-Agent Coordination Workflows

## Overview

This skill teaches the lead agent how to **plan and communicate** when forming a team. Rather than a single linear workflow, it presents distinct **workflow patterns** grounded in organizational behavior theory. Each pattern **shapes a communication topology** — who talks to whom, through what channel, in what order — because the structure of communication determines the quality of the result.

The central principle: **match the communication topology to the task.** Centralized topologies (Wheel, Chain) are efficient for simple or sequential work. Decentralized topologies (Circle, All-Channel) produce better results for complex, creative, or cross-domain work. Choosing the wrong topology wastes parallelism or starves cross-pollination.

## When to Form a Team

**Form a team when there are 3+ independent subtasks** that can benefit from parallel work, OR when the task requires distinct expertise (coder, reviewer, tester, researcher) that maps to separate agents.

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

**Good candidates:**
- Multiple independent tasks that can run in parallel
- Tasks requiring different expertise or perspectives
- Research tasks that can explore different sources
- Large features splittable into independent modules
- Iterative work that benefits from turn-taking

**Avoid team mode when:**
- Tasks are strictly sequential with no parallelism benefit
- Quick one-off operations that don't justify spawn overhead
- Subtasks share mutable state (e.g., editing the same file) AND the state cannot be partitioned by file/module boundary. If state CAN be partitioned (different files, different functions), team mode is still viable.

## Theoretical Lens

Two frameworks from organizational behavior anchor the patterns below.

### Mintzberg's Coordination Mechanisms
How organizations coordinate work among parts:
- **Mutual adjustment** — peers informally coordinate via feedback (decentralized)
- **Direct supervision** — a lead issues instructions and monitors results (centralized)
- **Work process standardization** — the steps are prescribed (e.g., a pipeline)
- **Output standardization** — only the deliverable spec is fixed, not the process
- **Skill standardization** — roles carry fixed expertise (coder, reviewer, tester)

### Bavelas/Leavitt Communication Networks
How information flows among nodes (5 topologies):
- **Wheel** — one hub, all spokes report to it; most centralized; efficient for simple tasks
- **Chain** — linear relay A→B→C; good for sequential processing
- **Y** — multiple inputs funnel to a single decision point
- **Circle** — decentralized ring; each node talks to neighbors; moderate collaboration
- **All-Channel** — everyone talks to everyone; best for complex creative tasks

### The Centralization–Decentralization Tradeoff
Centralized networks (Wheel, Chain) are **faster and more efficient for simple/routine tasks** but produce lower member "satisfaction" (analogous to teammates producing lower-quality output when denied autonomy). Decentralized networks (Circle, All-Channel) are **slower to coordinate but yield better results on complex, creative, or novel tasks** because information cross-pollinates. Choose the topology that matches the task's complexity and need for cross-domain synthesis.

## Workflow Patterns

Each pattern uses a consistent template:
**Theory basis → When to use → Communication topology → Tool sequence → Example → Pitfalls**

---

## Canonical Tool-Call Rules (apply to all patterns)

These rules resolve ambiguities that make the pattern tool sequences non-executable. Follow them in every pattern.

### Claim Rule
**The teammate claims its own issue.** The lead does NOT pre-claim issues on behalf of teammates.
- The lead creates issues (`issue_create`) and notifies teammates via `mail_to`.
- The teammate calls `issue_claim(id=N, owner="<own name>")` itself.
- Exception: if a teammate lacks `issue_claim` tool access, the lead claims on its behalf.
- Therefore: the pattern tool sequences below show `issue_claim` as a teammate action, not a lead action.

### Closure Rule
**The agent that completed the work closes the issue.**
- If the teammate completed the work, the teammate calls `issue_close` (set `poster="<teammate name>"`).
- If the lead integrates and the teammate is no longer active, the lead calls `issue_close` (set `poster="lead"`).
- The `poster` field MUST reflect who actually performed the closure.

### Broadcast Rule
`broadcast(title, content)` sends to **ALL currently-spawned teammates**. There is no recipient filter. To reach a subset, use individual `mail_to` calls instead.

### Polling Procedure (for the lead between async work)
- Call `issue_list()` after completing each unit of your own work (e.g., after sending a mail, after integrating one result).
- Do NOT call `issue_list()` more than once per response turn without doing other work in between.
- If all issues are still in_progress and you have no other work, end your turn and wait for mail notifications.
- If an issue has been in_progress for >3 consecutive `issue_list` checks with no comment updates, mail the owner to check status.

---

### Pattern 1: Divide-and-Conquer (Wheel)

**Theory basis:** Mintzberg output standardization + direct supervision; Bavelas Wheel.

**When to use:** A task splits into 3+ **independent** subtasks with no dependencies. Each teammate works on a separate slice; the lead integrates.

**Communication topology — Wheel (centralized):**
```
        teammate-1
            |
teammate-2 — LEAD — teammate-3
            |
        teammate-4
```
The lead is the hub. **Teammates do NOT talk to each other.** All communication flows through the lead. Each teammate reports progress to the lead; the lead relays integration results back.

**Tool sequence:**
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
#    see the tm_await Decision Tree in Async-First Principles).
#    OR simply wait for mail from teammates and check issue_list.

# 7. Teammates close their own issues (per the Closure Rule):
#    teammate a: issue_close(id=1, status="completed", comment="...", poster="a")
#    teammate b: issue_close(id=2, status="completed", comment="...", poster="b")
#    teammate c: issue_close(id=3, status="completed", comment="...", poster="c")
```

**Example:** Research a codebase — teammate A maps the data layer, B maps the API layer, C maps the UI layer. Each reports findings to the lead; the lead synthesizes the architecture overview.

**Pitfalls:**
- **Do NOT `tm_await` immediately after spawning** — that serializes parallel work. Let teammates run; check `issue_list`.
- **Do NOT allow lateral communication** — if teammates start mailing each other, you no longer have a Wheel and integration gets messy.
- **Define clear acceptance criteria** (output standardization) so each slice integrates cleanly.

---

### Pattern 2: Pipeline / Chain Relay (Chain)

**Theory basis:** Mintzberg work process standardization; Bavelas Chain.

**When to use:** Subtasks are **sequentially dependent** — each stage's output is the next stage's input. The order is fixed.

**Communication topology — Chain (linear relay):**
```
LEAD → A → B → C → LEAD
```
Work flows in one direction. Each teammate receives from the prior stage and passes to the next. The lead initiates and receives the final result.

**Tool sequence:**
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

**Example:** Build a feature — design the API → implement it → write tests → write docs. Each stage consumes the prior artifact.

**Pitfalls:**
- **Do NOT `tm_await` between every stage** — blocking issues already serialize the work. The lead can do other work while a stage runs; check `issue_list` per the Polling Procedure to see which stage is active.
- **Relay the prior stage's output** in the mail to the next teammate — the Chain depends on each link passing the artifact forward. Use the Pipeline Relay Procedure above.
- **One teammate per stage** — if a stage stalls, the whole pipeline stalls. If an issue is in_progress for >3 checks with no comment updates, mail the owner (per the Polling Procedure).

---

### Pattern 3: Play-in-Turn / Round-Robin (Circle)

**Theory basis:** Bavelas Circle; Mintzberg mutual adjustment.

**When to use:** A single artifact needs **iterative refinement** through repeated passes by different teammates, each improving on the previous version.

**Communication topology — Circle (decentralized ring):**
```
      A
     / \
    LEAD  B → C
     \ /
      (cycle repeats)
```
Each teammate takes a turn, builds on the previous output, and passes to the next. The lead orchestrates the turn order and closes the loop when the artifact is ready.

**Tool sequence:**
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

**Stopping Condition Templates (state one before starting the cycle):**
```
- Fixed passes:    "We will do exactly N passes. Stop after pass N closes."
- Criterion-based: "Stop when [teammate name] reports 'no changes needed' in their issue comment."
- Lead-judgment:   "After each pass, the lead reviews the artifact against the acceptance
                    criteria in issue #1. If it meets them, the lead stops the cycle and
                    closes all remaining issues."
```

**Example:** Write a design doc — draft → critique → revise → polish. Or a code review cycle: implement → review → fix → verify.

**Pitfalls:**
- **The lead must relay each turn's output** to the next teammate — the Circle does not self-advance; the lead is the conductor (same relay mechanism as the Pipeline).
- **Decide the stopping condition upfront** — use one of the Stopping Condition Templates above and write it into issue #1's content before pass 1 starts. Without it, the cycle never ends.
- **Do NOT let teammates jump ahead** — the blocking issue chain enforces turn order; respect it.

---

### Pattern 4: Lectural / Broadcast (One-to-Many)

**Theory basis:** Mintzberg direct supervision + skill standardization; one-to-many communication.

**When to use:** The **same context/task** must be addressed by multiple teammates simultaneously, each from their own role's perspective. Distinct from Divide-and-Conquer: here everyone gets the *same* input, not different slices.

**Communication topology — Star broadcast (one-to-many):**
```
            LEAD
           /  |  \
          /   |   \
      tm-1  tm-2  tm-3
```
The lead broadcasts identical context to all teammates at once. Each works independently with that shared context. Teammates report back to the lead; they do NOT talk to each other.

**Tool sequence:**
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

**Example:** "Everyone review this PR from your role's perspective" — security, performance, and maintainability reviewers all get the same PR and report back independently.

**Pitfalls:**
- **`broadcast` is lead-only** — teammates cannot broadcast; they mail_to the lead.
- **Broadcast ≠ Divide-and-Conquer** — broadcast sends the *same* task to all; divide-and-conquer sends *different* slices. Do not conflate them.
- **Define each teammate's perspective in their `tm_create` prompt** so the reviews don't overlap redundantly.

---

### Pattern 5: Peer Review / All-Channel (All-Channel)

**Theory basis:** Bavelas All-Channel; Mintzberg mutual adjustment.

**When to use:** **Complex, creative, or cross-domain** tasks where the best solution emerges from teammates negotiating with each other — e.g., an architecture where frontend, backend, and devops must agree on interfaces. This is the most decentralized topology; use it when cross-pollination is essential.

**Communication topology — All-Channel (fully connected):**
```
      tm-1 —— tm-2
       |  \  /  |
       |   \/   |
       |   /\   |
       |  /  \  |
      tm-3 —— LEAD (informed, not hub)
```
Teammates communicate **laterally** with each other (`mail_to` between teammates). The lead stays informed but does NOT relay every message — it monitors via `issue_list` and intervenes only if the team stalls.

**Tool sequence:**
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

**Stall Detection (All-Channel):**
```
- After broadcasting the kickoff, call issue_list() once per turn (per Polling Procedure).
- If no issue_comment has been added by ANY teammate for ≥2 consecutive issue_list checks,
  mail ALL teammates: "Status check — have you reached agreement? Reply with your current position."
- If all teammates reply "waiting on [other teammate]," arbitrate by mailing a decision proposal.
- If a teammate mails "impasse" or "deadlock," arbitrate immediately (same turn).
- Use tm_print() to check for teammates stuck in 'idle' — this may indicate broken lateral
  communication (Silent Wheel degradation). If so, re-mail them with explicit peer instructions.
```

**Example:** Design a system where frontend, backend, and devops must agree on API contracts and deployment boundaries. The teammates negotiate directly; the lead only arbitrates deadlocks.

**Pitfalls:**
- **Lateral communication must be EXPLICITLY instructed** in each `tm_create` prompt — teammates default to talking to the lead, not each other. Without instruction, you silently get a Wheel, not an All-Channel.
- **Higher coordination cost** — use only when the task genuinely needs cross-domain synthesis. For simple independent work, use Divide-and-Conquer instead.
- **Monitor for stalls** — if teammates mail the lead with an impasse, arbitrate promptly; otherwise the team deadlocks.

---

### Pattern 6: Funnel / Y-Pattern (Y)

**Theory basis:** Bavelas Y; multiple inputs converge to a single decision-maker.

**When to use:** Several independent explorations must **converge into one decision or synthesis**. Multiple explorers investigate; one integrator decides.

**Communication topology — Y (funnel):**
```
      explorer-1
          \
      explorer-2 → INTEGRATOR → LEAD
          /
      explorer-3
```
Explorers report to the integrator (not directly to the lead). The integrator synthesizes all findings and reports to the lead.

**Tool sequence:**
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

**Example:** Three researchers explore different solution approaches; one integrator evaluates all three and picks the best, reporting the decision to the lead.

**Pitfalls:**
- **Explorers mail the integrator, NOT the lead** — the Y topology routes through the integrator. If explorers mail the lead, you have a Wheel, not a Y.
- **The integrator must wait for ALL explorers** — use `blockedBy=[all explorer ids]` so it only starts once all findings are in.
- **Do NOT `tm_await` each explorer serially** — let them run in parallel; the blocking issue gates the integrator.

---

### Pattern 7: Human-in-the-Loop (Direct Supervision with Human Node)

**Theory basis:** Direct supervision with the human as an authoritative node in the topology.

**When to use:** A human user is a participant in the coordination flow — not a spectator. The human has their own turn and must not be automated past.

**Communication topology — Human as authoritative node:**
```
LEAD ↔ HUMAN ↔ teammate(s)
```
The lead is the hub that relays between the human and teammates. The human's turn is explicit and must not be skipped.

**Rules for human-in-the-loop coordination:**

1. **Define the protocol upfront** — tell all participants (including the human) who goes in what order and how each turn flows.
   ```
   # GOOD: State the protocol upfront
   "Here's our protocol: I'll ask you for input → you type in chat → I relay to John → John responds → I tell you the result. Your turn: please type your answer when I prompt you."

   # BAD: Assume the human knows when to interject
   "Let's play a game. John, pick a number. I'll guess."
   ```

2. **Hand off turns explicitly** — do NOT proceed through the human's turn automatically. When it's the human's turn, state clearly: "It's your turn now. Please [describe what they should do]." Then **stop and wait** for their response.

3. **Clarify the submission channel** — explain HOW the human submits their turn (e.g., "type your answer in the chat", "run this command in the terminal"). The `hand_over` tool creates an interactive terminal for SSH/vim/passwords; for chat-based input, simply ask in your response and wait.

4. **Do not bypass the human's turn** — if you are waiting for the human, actually stop and wait. Using `tm_await` on a teammate behind the human's back removes the human from the loop.

5. **Handle mixed turn orders** — when the team includes both agents and the human, the lead orchestrates the full sequence:
   ```
   lead → human (input) → lead → teammate (process) → lead → human (result) → ...
   ```

**Tool sequence:**
```
# Lead announces the protocol
issue_create(title="Activity with human participation", content="...")
tm_create(name="john", role="secret-keeper", prompt="Claim issue #1. Wait for guesses via mail. Respond higher/lower.")

# Lead explicitly tells the user
"I'll coordinate: you guess → I relay to John → John says higher/lower → I tell you. Your turn — make a guess!"

# User responds: "50"
# Lead relays to teammate
mail_to(name="john", title="Guess: 50", content="User guessed 50. Respond higher/lower.")
# (await john ONLY here, because you cannot proceed without his answer)
tm_await(name="john")

# Lead collects result and hands back to human
"John says: Lower. Your turn again — guess again!"

# Repeat the cycle — never skip the human's turn
```

**Key differences from Patterns 1–6:**
- The human cannot be given an issue to claim — you communicate via chat.
- The lead MUST stop and explicitly prompt the human at each turn.
- The human's input arrives via their chat response, not via a tool.
- Never use `tm_await` on a teammate in a way that bypasses the human turn.

**Pitfalls:**
- **Automating past the human** — the most common failure mode. The lead coordinates only between teammates and the user watches output scroll by.
- **Using `tm_await` to skip the human's turn** — if the human is next, do not block on a teammate.
- **Vague turn handoffs** — always state exactly what the human should do and how to submit it.

---

## Choosing a Workflow

Match the task to the topology:

| Task shape | Recommended pattern | Topology |
|---|---|---|
| 3+ independent slices, lead integrates | Divide-and-Conquer | Wheel |
| Sequential stages, each feeds the next | Pipeline / Chain | Chain |
| One artifact, iterative refinement by passes | Play-in-Turn / Round-Robin | Circle |
| Same task, multiple perspectives | Lectural / Broadcast | Star (one-to-many) |
| Complex, creative, cross-domain negotiation | Peer Review / All-Channel | All-Channel |
| Multiple explorations → one decision | Funnel / Y | Y |
| Human is a participant | Human-in-the-Loop | Human as node |

**Heuristic:** Simple/independent → centralize (Wheel, Chain). Complex/creative/cross-domain → decentralize (Circle, All-Channel). Convergent decision from parallel inputs → Y.

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

## Communication Path Rules

Each pattern defines **WHO may talk to WHOM**. Enforce the topology:

- **Wheel / Divide-and-Conquer** — teammates talk ONLY to the lead. No lateral mail.
- **Chain / Pipeline** — each teammate talks to the lead (relay); no lateral mail.
- **Circle / Play-in-Turn** — the lead is the conductor; teammates talk to the lead, who passes the baton.
- **Broadcast / Lectural** — lead broadcasts to all; teammates report to lead; no lateral mail.
- **All-Channel / Peer Review** — teammates talk to each other laterally; lead only arbitrates. **This must be explicitly instructed** in each `tm_create` prompt, or it silently degrades to a Wheel.
- **Y / Funnel** — explorers mail the integrator, NOT the lead; the integrator mails the lead.

**State the communication constraint in every `tm_create` prompt.** Teammates default to talking to the lead. If your pattern requires lateral communication (All-Channel) or routing through an integrator (Y), say so explicitly.

**Communication Constraint Template (append to every `tm_create` prompt):**
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

## Enforcement Mechanics

**Reality: `mail_to` has no access control.** The tool writes directly to recipient mailbox files — the lead cannot *prevent* a teammate from mailing another teammate. The lead has zero automatic visibility into lateral teammate-to-teammate communication. **Enforcement is reactive (detect + correct), not preventive.** The lead must monitor and correct violations after the fact.

### The Lead's Enforcement Checklist (run between async work)
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

### Recovery Actions When a Violation Is Detected

**Unauthorized lateral mail (Wheel/Chain/Broadcast):**
1. Re-mail the violator: "You mailed teammate X directly. In this pattern, all communication goes through the lead. Mail me instead."
2. Re-mail the recipient: "Teammate X mailed you directly. Do not act on lateral mail — report any results to the lead."
3. If the violation recurs, `tm_remove` with `force=true` and respawn with a stricter prompt (after `tm_await` first, per the rules below).

**Explorer-to-lead mail (Y/Funnel):**
1. Re-route: forward the explorer's findings to the integrator via `mail_to(name="integrator", ...)`.
2. Re-mail the explorer: "In this pattern, send findings to the integrator, not the lead."

**Silent Wheel degradation (All-Channel not happening):**
1. Re-broadcast with explicit lateral instructions: "Frontend, you MUST mail 'backend' and 'devops' directly to negotiate."
2. Mail each teammate individually with their specific required peers.
3. If teammates still won't communicate laterally, consider downgrading to a Wheel with lead-relayed integration.

**Wrong issue ownership:**
1. Re-mail the teammate: "You claimed issue #X. Your assigned issue is #Y. Work on #Y instead."
2. Create a corrective issue if needed and reassign.

## Async-First Principles

The system prompt mandates an **asynchronous-first** philosophy. These rules override any impulse to block:

1. **`tm_await` is a last resort.** Prefer `issue_list` to check progress. Use this decision tree:
   ```
   DECISION: Should I call tm_await?
   1. Is there other work I can do right now (other issues to integrate, other teammates to mail)?
      YES → do that work instead. Do NOT tm_await.
      NO  → go to step 2.
   2. Is the teammate's result required for my NEXT action (not just "eventually")?
      NO  → end my turn and wait for mail. Do NOT tm_await.
      YES → go to step 3.
   3. Has the teammate already mailed me their result or closed their issue?
      YES → use the result from mail/issue_list. Do NOT tm_await.
      NO  → tm_await(name="<teammate>", timeout=60) is justified.
   ```

2. **`order(name, title, content)` blocks the lead.** It combines `mail_to` + `tm_await` and pauses the lead until the teammate finishes (default 60s timeout). Use this decision procedure:
   ```
   order() vs mail_to DECISION:
   - Use order() when: you need to send a task AND get the result in a single step,
     AND you have no other work to do while waiting.
   - Use mail_to alone when: you can continue other work while the teammate processes.
   - NEVER use order() when there are other independent teammates still running —
     it blocks the lead and freezes all parallel work.
   ```

3. **`tm_remove` requires `tm_await` first.** Let the teammate finish before removing it. Set `force=true` only for stuck teammates.

4. **`broadcast` and `tm_create` are lead-only tools.** Teammates cannot spawn peers or broadcast; they use `mail_to` to the lead (or to each other, if instructed).

5. **Let teammates work.** Spawn, assign, then step back. Collect results via `issue_list` and mail, not by blocking on every step. Follow the Polling Procedure.

## Common Anti-Patterns

- **Silent Wheel** — intending All-Channel but never instructing lateral communication; teammates default to mailing the lead and cross-pollination never happens.
- **Serializing parallel work** — calling `tm_await` immediately after spawning independent teammates, defeating the purpose of parallelism.
- **Wrong topology for the task** — using a Wheel for a complex creative task (starves synthesis) or All-Channel for a trivial independent task (wastes coordination cost).
- **Automating past the human** — in Human-in-the-Loop, blocking on a teammate while the human waits for their turn.
- **Mail-only assignment** — assigning work via `mail_to` without an issue; no visibility, no status tracking. Always pair `issue_create` + `issue_claim` with `mail_to`.

## Troubleshooting

### Teammate Not Responding
- Check `tm_print` — is the process alive (working/idle/shutdown)?
- Mail the teammate to check status using this template:
  ```
  mail_to(name="<teammate>", title="Status check", content="""
  Are you still working on issue #N? Reply with:
  - Current status (in progress / blocked / done)
  - What you're doing right now
  - Any blockers you've hit
  """)
  ```
- Use `tm_await` with a timeout as a last resort (per the decision tree in Async-First Principles).
- If stuck, `tm_remove` with `force=true` (after attempting `tm_await`).

### Issue Blocked
- Check `issue_list` to see which issue is blocking and its status.
- Wait for the blocking issue to close — closing a blocker automatically unblocks dependents.
- If the blocker's owner is stuck, mail them or reassign.

### Task Too Complex
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
   and the Tie-Breaking Rule.
```

## Summary

1. **Match the communication topology to the task** — centralize for simple/independent, decentralize for complex/creative. Use the Tie-Breaking Rule for multi-match tasks.
2. **State the communication constraint in every `tm_create` prompt** — use the Communication Constraint Template with explicit MAY/MAY NOT mail lists. The topology is only enforced if teammates know who they may talk to.
3. **Use issues for all work** — visibility, dependencies, and status tracking. Teammates claim and close their own issues (Claim Rule, Closure Rule).
4. **Enforcement is reactive** — `mail_to` has no access control; the lead detects violations via the Enforcement Checklist and corrects them with recovery procedures.
5. **Async-first** — use the `tm_await` decision tree and the `order()` decision procedure; `tm_await`/`order()` are last resorts. Follow the Polling Procedure for progress checks.
6. **`tm_remove` requires `tm_await` first**; `force=true` only for stuck teammates.
7. **When the human is involved, treat them as a first-class participant** — define the protocol upfront, hand turns explicitly, never skip their turn.