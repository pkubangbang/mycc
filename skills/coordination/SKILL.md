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

Use `tm_await` to wait for teammate completion:
```
tm_await()  # Wait for all teammates
# or
tm_await(name="coder", timeout=60000)  # Wait for specific teammate
```

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
todo_write([{ name: "Wait for coder" }])  # Doesn't show actual task status
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