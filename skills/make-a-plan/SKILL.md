---
name: coding-task-planner
description: >
  Use this before implementing any non-trivial coding task.

  Helps plan tasks such as:
  - building new features
  - designing APIs or systems
  - refactoring code
  - debugging complex issues
  - adding integrations or infrastructure

  If the user asks to build or modify code, this skill should be used first.

  Relevant for:
  build, implement, create, develop,
  design, architect, plan,
  refactor, rewrite, improve,
  debug, fix, investigate,
  add feature, extend system

  Example requests:
  - "build a login system"
  - "refactor this module"
  - "add caching layer"
  - "design an API"

  Do NOT use for trivial or one-step tasks.
keywords: [planning, coding, workflow, best-practices]
---

# Make-a-Plan Skill

This skill guides the agent in creating structured plans for coding tasks.


## Plan Mode Integration

Use `plan_on` to enter a restricted mode where code changes are prohibited while planning:

```
# Enter plan mode (strict - no code changes allowed)
plan_on()

# Enter plan mode with an allowed file (e.g., a planning doc)
plan_on(allowed_file="docs/design.md")
```

When planning is complete and you're ready to implement, use `plan_off` to exit plan mode:

```
# Exit plan mode (requires user confirmation)
plan_off()
```

**Why use plan mode:**
- Prevents accidental code changes while discussing the plan
- User can approve the plan before any edits happen
- `plan_off` requires explicit user confirmation [y/N] to exit

## General Workflow

Planning is a two-sided process: **user alignment first, then structured planning**.

---

### Step 1: Establish Assumptions (MANDATORY)

Before planning, explicitly state assumptions and common knowledge.

**Do NOT proceed until:**
- User confirms assumptions, OR
- User explicitly allows proceeding

Example:
> "Before we plan, here are my assumptions:
> - ...
> - ...
> Does this match your understanding? Any corrections?"

---

### Step 2: Structured Plan Output

Produce a plan using the following format:

## Plan

### Goal
Clear, testable objective.

### Assumptions
Confirmed or explicitly accepted assumptions.

### Task Breakdown
- Atomic, ordered tasks
- Each task clearly scoped

### Acceptance Criteria
- Measurable success conditions
- Verifiable outcomes

### Impact Analysis
- Affected files/modules
- Breaking changes
- Risks and mitigations
- Dependencies

### Bold Guesses (Optional)
- संभावित implementation ideas
- Clearly marked as guesses, not requirements

### Open Questions
- Anything unclear or requiring user decision

### Next Step Options
- Flesh out technical details
- Split into phases
- Start coding

---

## PEX (Progressive Explanation)

Use when explaining systems, architecture, or unfamiliar concepts.

### Rules
- Numbered list
- Each step builds on previous
- Progressive complexity

### Purpose
Allows user to identify the first point of confusion.

Use PEX selectively (not required for simple tasks).

---

## Critical Transitions

---

### Transition 1: Flesh Out Technical Details

**Trigger**: User confirms assumptions and asks for deeper detail.

**Actions**:
1. Read relevant code/context
2. Identify key design decisions
3. Present multiple options with trade-offs
4. Ask user to choose
5. Update plan with chosen approach

---

### Transition 2: Split into Phases

**Trigger**: Plan is large or user requests phased delivery.

**Actions**:
1. Define phase boundaries
2. Ensure dependency order
3. Provide deliverable per phase
4. Define acceptance criteria per phase

**Guideline**:
- Phase 1: Core (MVP)
- Phase 2: Enhancements
- Phase 3: Optimization/polish

---

### Transition 3: Start Coding

**Trigger**: User approves plan.

**Actions**:
1. Restate first task
2. Create task tracking (use `issue_create` for complex tasks, `todo_create` for simple tracking)
3. Start from smallest atomic task
4. Report progress incrementally

---

## Anti-Patterns (Avoid)

- Starting coding without confirmed assumptions
- Making code changes during planning — use `plan_on` first
- Vague tasks like "implement feature"
- Missing acceptance criteria
- Making irreversible design decisions without user input
- Skipping impact analysis for non-trivial changes

---

## Core Principle

Always convert:
> vague request → explicit plan → validated approach → implementation

Never jump directly from request to code unless the task is trivial.