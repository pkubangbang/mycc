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
  and overly complex task decomposition. Use for distributing independent
  work across teammates, running tasks in parallel, coordinating multi-agent
  workflows, or managing a team of agents. Avoid for purely sequential
  tasks with no parallelism benefit or quick one-off operations.
keywords: [team, coordination, workflow, parallel, distribute, spawn, teammate, multi-agent, delegate, collaborate, issue, task, broadcast, handoff, concurrency, tm_create, tm_await, order]
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