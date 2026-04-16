# How to Handle Team Coordination

## Overview

This guide explains how the lead agent should coordinate teammates (child process agents) effectively, with proper timing, explicit waiting, and status awareness.

## Core Principles

### 1. Be Explicit About Waiting

**Do NOT rely on implicit waiting.** The agent loop will NOT automatically wait for teammates. You must explicitly call `tm_await` when you need results before proceeding.

```
# BAD: Implicit expectation that teammates finish
mail_to("coder", "implement feature X")
# ... no tm_await, assumes coder finishes

# GOOD: Explicit waiting when results are needed
mail_to("coder", "implement feature X")
tm_await("coder", timeout=60000)  # Wait for completion
```

### 2. Check Status Before Deciding

Use `tm_print` or `tm_await(block=false)` to check teammate status before deciding what to do:

```
tm_print  # Check current team status

# If teammates are "working": they're busy
# If teammates are "idle": they're available
# If teammates are "holding": they have a question
# If teammates are "shutdown": they're done
```

### 3. Understand Status Semantics

| Status | Meaning | What Lead Should Do |
|--------|---------|---------------------|
| `working` | Actively processing | Wait (tm_await) or do other work |
| `holding` | Blocked on question | Answer the question via mail_to |
| `idle` | Waiting for work | Assign new task via mail_to |
| `shutdown` | Process exited | No further action possible |

## Coordination Patterns

### Pattern 1: Spawn, Task, Wait, Cleanup

The canonical pattern for synchronous teammate work:

```
1. tm_print                          # Check existing teammates
2. tm_create("worker", role, prompt) # Spawn with unique name
3. tm_print                          # Verify spawn succeeded
4. mail_to("worker", title, content) # Send task
5. tm_await("worker", timeout=60000) # Explicitly wait
6. tm_print                          # Check final status
7. tm_remove("worker")               # Cleanup
8. tm_print                          # Verify removal
```

### Pattern 2: Fire and Forget

For async work where you don't need immediate results:

```
1. tm_create("worker", role, prompt)
2. mail_to("worker", title, content)
3. # Continue with other work without tm_await
4. # Later: check status with tm_print
5. # Collect results via mail from teammate
```

### Pattern 3: Parallel Workers

For multiple independent tasks:

```
1. tm_create("worker-a", role, prompt)
2. tm_create("worker-b", role, prompt)
3. mail_to("worker-a", "task A", ...)
4. mail_to("worker-b", "task B", ...)
5. tm_await(timeout=120000)  # Wait for ALL teammates
6. tm_remove("worker-a")
7. tm_remove("worker-b")
```

### Pattern 4: Check Progress Without Blocking

When you want to see progress but continue working:

```
1. tm_await(block=false)  # Returns status immediately
2. # See: "worker-a: working, worker-b: idle"
3. # Decide: wait more, or continue with other tasks
```

## Timing Considerations

### Mail Polling Delay

Teammates poll for mail every 5 seconds. After `mail_to`, the teammate may not receive it instantly.

```
mail_to("worker", task)
# Teammate receives mail within 5 seconds
# Teammate starts processing
# Teammate sends status update: "working"
```

### Minimum Wait Time

When calling `tm_await`, there's a minimum 5-second wait to allow teammates to process mail and potentially ask questions.

### Appropriate Timeouts

Choose timeout based on task complexity:

| Task Type | Recommended Timeout |
|-----------|---------------------|
| Quick lookup/read | 30 seconds |
| File modification | 60 seconds |
| Complex analysis | 120 seconds |
| Multi-step task | 300 seconds |

## Handling Timeout

When `tm_await` times out, you have options:

```
# tm_await returns status on timeout:
{
  "settled": false,
  "teammates": [
    {"name": "worker", "status": "working", "last_activity": "..."}
  ],
  "elapsed": 60000
}

# Your options:
1. tm_await(timeout=120000)        # Wait longer
2. tm_print                         # Check current status
3. mail_to("worker", "progress?")   # Ask for update
4. tm_remove("worker")              # Give up on stuck worker
5. continue                         # Proceed without waiting
```

## Handling Questions (Holding Status)

When a teammate has a question, it enters `holding` status. You should answer promptly:

```
# Teammate in "holding" status means:
# - It asked a question via core.question()
# - It's blocked waiting for your answer
# - It cannot proceed until answered

# Check pending questions in mail:
# Mail from worker: Question: Should I use X or Y?

# Answer the question:
mail_to("worker", "Re: Question", "Use X, it's more efficient.")
# Teammate resumes "working" status
```

## Error Recovery

### Orphaned Teammates

Teammates that exist but were never tasked:

```
tm_print
# Shows: "worker: idle" but you never sent mail

# Solution: Either task them or remove them
mail_to("worker", task)  # or
tm_remove("worker")
```

### Double Spawn Attempt

Trying to create a teammate with existing name:

```
tm_create("worker", ...)  # First spawn
tm_create("worker", ...)  # Error: already exists

# Solution: Check first, or use different name
tm_print  # Check if name exists
tm_create("worker-2", ...)  # Use unique name
```

### Stale Reference

Referencing a removed teammate:

```
tm_remove("worker")
mail_to("worker", task)  # Error: teammate not found

# Solution: Verify existence before mail_to
tm_print  # Check if teammate exists
```

## Best Practices

### DO

- ✅ Call `tm_print` before and after `tm_create`
- ✅ Call `tm_print` before `mail_to` to verify teammate exists
- ✅ Use explicit `tm_await` when you need results
- ✅ Use unique, descriptive teammate names
- ✅ Always pair `tm_create` with `tm_remove`
- ✅ Answer questions promptly (teammates in `holding` status)
- ✅ Choose appropriate timeouts based on task complexity

### DON'T

- ❌ Assume teammates finish instantly after `mail_to`
- ❌ Call `tm_create` without checking for existing name
- ❌ Forget to call `tm_remove` after work is done
- ❌ Call `mail_to` after `tm_remove`
- ❌ Use `tm_await` without timeout
- ❌ Ignore teammates in `holding` status

## Quick Reference

### Status Flow

```
spawn → working → [tool calls] → working
                     ↓
              [no tool calls] → idle → [new mail] → working
                     ↓
              [ask question] → holding → [get answer] → working
                     ↓
              [shutdown/SIGTERM] → shutdown
```

### Decision Tree

```
Need teammate results before proceeding?
├─ Yes → tm_await(timeout=appropriate)
│         ├─ Returns settled=true → proceed
│         └─ Returns settled=false → decide: wait more, check, or continue
└─ No → continue with other work
         └─ Check status later with tm_print or tm_await(block=false)
```

### Tool Sequence Checklist

- [ ] tm_print (check existing)
- [ ] tm_create (spawn)
- [ ] tm_print (verify spawn)
- [ ] mail_to (send task)
- [ ] tm_await (wait for results) ← EXPLICIT
- [ ] tm_print (check final status)
- [ ] tm_remove (cleanup)
- [ ] tm_print (verify cleanup)