---
name: coordination
description: >
  Use when tasks can benefit from parallel work.

  Helps coordinate:
  - spawning multiple teammates
  - distributing independent tasks
  - collecting and integrating results

  Relevant for:
  team, parallel, distribute, spawn, teammate, coordinate

  Example requests:
  - "run these tasks in parallel"
  - "coordinate a team to do X"
  - "spawn teammates for these tasks"

  Avoid for sequential tasks or quick one-off work.
keywords: [team, coordination, workflow, parallel, distribute]
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

### Step 1: Plan with Issues

Before creating teammates:
1. Use `issue_create` to define tasks clearly
2. Use `blockage_create` to set dependencies between issues
3. Verify issues are ready (no blockers, clear content)

### Step 2: Create Teammates

Use `tm_create` to spawn teammates:
```
tm_create(name="coder", role="developer", prompt="Your task: implement X...")
tm_create(name="reviewer", role="code reviewer", prompt="Your task: review Y...")
```

**Important**: Provide complete context in the prompt including:
- Clear task description
- Relevant file paths
- Success criteria
- Constraints and preferences

### Step 3: Write Kickoff Todos

After creating teammates, use `todo_write` to track:
```
todo_write([
  { name: "Spawn teammate: coder", done: true },
  { name: "Spawn teammate: reviewer", done: true },
  { name: "Send task to coder via mail_to", done: false },
  { name: "Send task to reviewer via mail_to", done: false },
  { name: "Wait for coder result", done: false },
  { name: "Wait for reviewer result", done: false },
  { name: "Integrate results and report to user", done: false }
])
```

### Step 4: Distribute Tasks

Use `mail_to` to send tasks:
```
mail_to(name="coder", title="Implement feature X", content="Details...")
mail_to(name="reviewer", title="Review PR #123", content="Details...")
```

### Step 5: Monitor Progress

Use `tm_await` to wait for completion:
```
tm_await()  # Wait for all teammates
# or
tm_await(name="coder", timeout=60000)  # Wait for specific teammate
```

Check mail for updates:
- Teammates send progress updates via `mail_to` to "lead"

### Step 6: Collect and Integrate

After teammates complete:
1. Read mail from teammates
2. Integrate results
3. Use `brief` to update user on progress
4. Use `tm_remove` if teammates are no longer needed

## Communication Best Practices

### Sending Clear Tasks

```
# Good: Complete context
mail_to(name="coder", title="Fix login bug", content="""
Bug: Login fails on Chrome

Location: src/auth/login.ts, line 45-60
Error: "Invalid token" appears after clicking submit

Expected: Should redirect to dashboard
Please investigate and fix. Report progress via mail.
""")

# Bad: Vague task
mail_to(name="coder", title="fix login", content="it's broken")
```

### Receiving Results

Teammates will send mail with results. Check mail regularly:
- Use `brief` to update user on significant progress
- Use `todo_write` to track overall progress
- Respond to questions promptly via `mail_to`

## Common Patterns

### Pattern 1: Coder + Reviewer

```
# Create teammates
tm_create(name="dev", role="developer", prompt="Implement feature X...")
tm_create(name="rev", role="reviewer", prompt="Review code for quality...")

# First: dev works
mail_to(name="dev", title="Task: ...", content="...")

# Wait for dev
tm_await(name="dev")

# Then: reviewer checks
mail_to(name="rev", title="Review: ...", content="...")
tm_await(name="rev")

# Collect results and integrate
```

### Pattern 2: Parallel Researchers

```
# Create multiple researchers
tm_create(name="r1", role="researcher", prompt="Search for X...")
tm_create(name="r2", role="researcher", prompt="Search for Y...")
tm_create(name="r3", role="researcher", prompt="Search for Z...")

# Send tasks to all
mail_to(name="r1", title="Research topic A", content="...")
mail_to(name="r2", title="Research topic B", content="...")
mail_to(name="r3", title="Research topic C", content="...")

# Wait for all
tm_await()

# Collect and synthesize results
```

### Pattern 3: Issue-Based Workflow

```
# Create issues first
issue_create(title="Implement X", content="...")
issue_create(title="Test X", content="...", blockedBy=[1])

# Teammate claims and works on issue 1
tm_create(name="dev", role="developer", prompt="Claim and complete issues...")

# Issue 2 blocked until issue 1 is completed
# Teammate will auto-claim when blockers clear
```

## Troubleshooting

### Teammate Not Responding
- Use `tm_await` with timeout
- Check if teammate process is alive (use `tm_print` tool)
- Send mail to check status

### Confusion About Context
- Send more context via `mail_to`
- Include file paths and specific instructions
- Teammates can ask lead for clarification

### Task Too Complex
- Break into smaller subtasks
- Create separate issues for each
- Use multiple teammates with focused roles

## Summary

1. Plan with issues before creating teammates
2. Provide complete context in prompts
3. Use todo_write to track coordination
4. Use mail_to for task distribution
5. Use tm_await to wait for completion
6. Integrate results and report to user