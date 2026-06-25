---
name: coordination
description: >
  Use when tasks can benefit from parallel work or multi-agent collaboration.
  Covers the full team coordination workflow: creating issues for task
  tracking, spawning teammates with tm_create, assigning work via issues
  and mail_to, monitoring progress with issue_list and tm_print, waiting
  for completion with tm_await, and collecting results. Includes three
  common patterns: sequential tasks with blocking dependencies, parallel
  independent tasks, and issue-based handoff chains. Also covers
  communication best practices (ordering via order(), broadcasting with
  broadcast()), troubleshooting teammate non-response, blocked issues,
  and overly complex task decomposition. **Critically, includes guidance
  for human-in-the-loop coordination — treating the human as a first-class
  participant with explicit turn protocol, not a spectator.** Use for
  distributing independent work across teammates, running tasks in
  parallel, coordinating multi-agent workflows, or managing a team of
  agents. Avoid for purely sequential tasks with no parallelism benefit
  or quick one-off operations.
keywords: [team, coordination, workflow, parallel, distribute, spawn, teammate, "multi agent", delegate, collaborate, issue, task, broadcast, handoff, concurrency, tm_create, tm_await, order]
---

# Team Coordination Best Practices

## Overview

When tasks can benefit from parallel work, create teammates using `tm_create` to form a team. This skill provides guidance on effective team coordination.

## When to Use Team Mode

**Good candidates for team mode:**
- Multiple independent tasks that can run in parallel
- Tasks requiring different expertise (coder, reviewer, tester)
- Research tasks that can explore different sources
- Large features that can be split into independent modules

**Avoid team mode when:**
- Tasks are sequential with dependencies
- Quick tasks that don't justify spawn overhead
- Tasks requiring extensive shared state

## Coordination Workflow

### Step 1: Create Issues for Task Tracking

Use issues to track all work. Issues provide:
- Clear task definitions with acceptance criteria
- Dependency management via blocking relationships
- Progress tracking (pending → in_progress → completed)
- Persistent record of work done

```
# Create issues for each task
issue_create(title="Implement feature X", content="Details...")
issue_create(title="Add tests for X", content="...", blockedBy=[1])

# issue_create returns the full issue list so you can see all tasks
```

### Step 2: Create Teammates

Use `tm_create` to spawn teammates:
```
tm_create(name="coder", role="developer", prompt="Your task: implement X...")
tm_create(name="reviewer", role="code reviewer", prompt="Your task: review Y...")
```

**Important**: Provide complete context in the prompt including:
- Issue ID(s) to claim and work on
- Relevant file paths
- Success criteria
- Instructions to close issue when done

### Step 3: Assign Work via Issues

Lead agent assigns issues to teammates:
```
# Claim issues for specific teammates
issue_claim(id=1, owner="coder")
issue_claim(id=2, owner="reviewer")

# Notify teammates via mail
mail_to(name="coder", title="Claimed issue #1", content="You now own issue #1: Implement X...")
```

Or teammates can claim issues themselves if instructed in their prompt.

### Step 4: Monitor Progress

Use `issue_list` to check task status:
```
issue_list()  # Shows all issues with status, owner, and blockers
```

Use `tm_print` to check teammate availability:
```
tm_print()  # Shows all teammates with roles and status (working/idle/shutdown)
```

Use `tm_await` to wait for teammate completion:
```
tm_await()  # Wait for all teammates
# or
tm_await(name="coder", timeout=60000)  # Wait for specific teammate
```

**Tip**: `order(name, title, content)` combines `mail_to` + `tm_await` into a single call — use it when you need the teammate to complete work before you proceed.

Check mail for updates from teammates.

### Step 5: Close Issues When Done

When a teammate completes their work:
```
issue_close(id=1, status="completed", comment="Feature X implemented", poster="coder")
```

Closing a blocker automatically unblocks dependent issues.

### Step 6: Collect and Integrate

After teammates complete:
1. Use `issue_list` to verify all issues are resolved
2. Read mail from teammates for details
3. Use `brief` to update user on progress
4. Use `tm_remove` if teammates are no longer needed

**Tip**: Use `broadcast(title, content)` to send team-wide announcements (e.g., "all tasks complete, wrap up").

## Communication Best Practices

### Assigning Tasks via Issues

```
# Good: Claim + notify
issue_claim(id=1, owner="coder")
mail_to(name="coder", title="Assigned issue #1: Fix login bug", content="""
Issue #1 is now assigned to you.

Location: src/auth/login.ts
Error: "Invalid token" appears after clicking submit

Expected: Should redirect to dashboard
Please investigate and fix. Close the issue when done.
""")

# Bad: Mail only (no issue tracking)
mail_to(name="coder", title="fix login", content="it's broken")
```

### Tracking Progress

```
# Good: Use issues for status
issue_list()  # See all task status at a glance
issue_close(id=1, status="completed", comment="Fixed")

# Bad: Use todos to track team work
todo_create("Wait for coder")  # Doesn't show actual task status
```

### Human Participants in Team Activities

**CRITICAL: When a human user is part of the coordination flow, the lead agent MUST NOT treat them as a spectator.**

The human is a first-class participant with their own turn in the sequence. Common failure mode: the lead coordinates only between spawned teammates, automating past the human as if the user is just an observer watching the output scroll by.

**Rules for human-in-the-loop coordination:**

1. **Explicitly define the protocol** before starting. Tell all participants (including the human) who goes in what order and how each turn flows.
   ```
   # GOOD: State the protocol upfront
   "Here's our protocol: I'll ask user for input → user types in chat → I relay to John (secret keeper) → John responds → I tell user the result. User, please type your answer when I prompt you."

   # BAD: Assume the human knows when to interject
   "Let's play a game. John, pick a number. I'll guess."
   ```

2. **Hand off turns explicitly** — do NOT proceed through the human's turn automatically. When it's the human's turn:
   - State clearly: "It's your turn now. Please [describe what they should do]."
   - Wait for their response before continuing with the next agent.
   - The `hand_over` tool creates an interactive terminal (for SSH, vim, etc.). For chat-based input, simply ask the user in your response and wait.

3. **Clarify the submission channel** — explain HOW the human should submit their turn (e.g., "type your answer in the chat", "run this command in the terminal").

4. **Do not bypass** the human's turn by continuing automation. If you are waiting for the human, actually stop and wait. Using `tm_await` for a teammate behind the human's back effectively removes the human from the loop.

5. **Handle mixed turn orders** — when the team includes both agents and the human, the lead must orchestrate the full sequence:
   ```
   lead → human (input) → lead → teammate (process) → lead → human (result) → ...
   ```
   The lead is the hub that relays information between the human and spawned teammates.

**Correct example:**
```
# Lead announces the protocol
issue_create(title="Number guessing game", content="User guesses, human secret-keeper responds")
tm_create(name="john", role="secret-keeper", prompt="...")

# Lead explicitly tells the user
"I'll coordinate: you guess → I relay to John → John says higher/lower → I tell you. Your turn, make a guess!"

# User responds with "50"
# Lead relays to teammate
mail_to(name="john", title="Guess: 50", content="User guessed 50. Respond with 'higher' or 'lower'.")
tm_await(name="john")

# Lead collects result and hands back to user
"John says: Lower. Your turn — guess again!"

# Continue the cycle — never skip the human's input step
```

## Common Patterns

### Pattern 1: Sequential Tasks (with blocking)

```
# Create issues with dependencies
issue_create(title="Implement X", content="...")
issue_create(title="Review X", content="...", blockedBy=[1])
issue_create(title="Test X", content="...", blockedBy=[2])

# Spawn teammates
tm_create(name="dev", role="developer", prompt="Claim issue #1 and implement X...")
tm_create(name="rev", role="reviewer", prompt="Claim issue #2 after #1 is closed...")

# Assign first task
issue_claim(id=1, owner="dev")
mail_to(name="dev", title="Start with issue #1", content="...")

# Wait for dev
tm_await(name="dev")

# Issue #1 closed automatically unblocks #2
# Notify reviewer
issue_claim(id=2, owner="rev")
mail_to(name="rev", title="Issue #2 is ready", content="...")
```

### Pattern 2: Parallel Tasks

```
# Create independent issues
issue_create(title="Research A", content="...")
issue_create(title="Research B", content="...")
issue_create(title="Research C", content="...")

# Spawn teammates
tm_create(name="r1", role="researcher", prompt="Claim and complete issue #1...")
tm_create(name="r2", role="researcher", prompt="Claim and complete issue #2...")
tm_create(name="r3", role="researcher", prompt="Claim and complete issue #3...")

# Assign all at once
issue_claim(id=1, owner="r1")
issue_claim(id=2, owner="r2")
issue_claim(id=3, owner="r3")

# Wait for all
tm_await()

# Check status
issue_list()
```

### Pattern 3: Issue-Based Handoff

```
# Create a chain of issues
issue_create(title="Design API", content="...")
issue_create(title="Implement API", content="...", blockedBy=[1])
issue_create(title="Write docs", content="...", blockedBy=[2])

# Teammate completes design
# Closing #1 unblocks #2
issue_close(id=1, status="completed", comment="API spec ready")

# Next teammate can now claim #2
issue_claim(id=2, owner="impl")
```

### Pattern 4: Human-in-the-Loop (Turn-Based)

```
# Scenario: Multi-agent activity involving the user
# Example: Number guessing game with human guesser and agent secret-keeper

# Step 1: Define protocol upfront to all participants
"Here's the protocol: user guesses → I relay → John responds → I tell user."

# Step 2: Create issues and spawn teammates
issue_create(title="Act as secret-keeper", content="Pick a number 1-100. Respond higher/lower.")
tm_create(name="john", role="secret-keeper", prompt="Claim issue #1. Pick a secret number. Wait for guesses via mail.")

# Step 3: Hand off to human explicitly
"User, it's your turn. Guess a number between 1 and 100."

# Step 4: Wait for human input, then relay to teammate
[User responds: "50"]
mail_to(name="john", title="Guess: 50", content="User guessed 50. Respond higher/lower.")
tm_await(name="john")

# Step 5: Relay response back to human
"John says: Lower. Your turn again!"

# Step 6: Repeat steps 3-5 — never skip the human's turn
```

**Key differences from Patterns 1-3:**
- The human cannot be given an issue to claim — you communicate with them via chat
- The lead MUST stop and explicitly prompt the human at each turn
- The human's input arrives via their chat response, not via a tool
- Never use `tm_await` on a teammate in a way that bypasses the human turn

## Troubleshooting

### Teammate Not Responding
- Use `tm_await` with timeout
- Check if teammate process is alive (use `tm_print` tool)
- Send mail to check status

### Issue Blocked
- Check `issue_list` to see which issue is blocking
- Wait for blocking issue to be closed
- Blocking issue close automatically removes the blockage

### Task Too Complex
- Break into smaller subtasks
- Create separate issues for each
- Use blocking relationships for dependencies

## Summary

1. **Create issues for all tasks** - provides visibility and tracking
2. **Claim issues before starting work** - establishes ownership
3. **Close issues when done** - updates status and unblocks dependents
4. **Use issue_list to check progress** - single source of truth
5. **Use mail_to for communication** - keep teammates informed
6. **Use tm_await to wait for completion** - collect and integrate results
7. **When humans are involved, treat them as first-class participants** — define the protocol upfront, hand turns explicitly, and never skip the human's turn