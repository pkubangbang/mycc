# Planning Skill

This skill guides the agent in creating structured plans for coding tasks.

## Two-Sided Approach

Planning is a two-sided process: user-facing first, then technical details.

### Step 1: Establish Assumptions and Common Knowledge

Before diving into any planning, **always start by stating assumptions and common knowledge**, then ask the user to confirm or correct them.

This ensures:
- Both parties share the same context
- Hidden assumptions are surfaced early
- Misunderstandings are caught before work begins

Example prompt:
> "Before we plan, let me state my assumptions: [list assumptions]. Does this match your understanding? Any corrections?"

### Step 2: Gather User Intent

After confirmation, ask the user about their intention to flesh out technical details. Wait for their response before proceeding.

## Key Components of a Plan

A complete coding plan should include:

### 1. Goal Definition
Clear, concise statement of what the plan aims to achieve. Should be specific enough to judge success.

### 2. Task Breakdown
Decompose the goal into actionable tasks. Each task should be:
- Atomic and well-scoped
- Clearly defined
- Ordered by dependencies when relevant

### 3. Acceptance Criteria
Measurable conditions that determine when the goal is achieved. Should be testable/verifiable.

### 4. Potential Impact to Existing Code
Analyze and document:
- Files/modules that may be modified
- Potential breaking changes
- Risks and mitigation strategies
- Dependencies affected

### 5. Bold Guess on Next Steps
Make educated guesses about implementation approaches or next actions. This serves as inspiration and supplements context for decision-making. Mark these explicitly as guesses, not requirements.

## PEX (Progressive Explanation)

PEX is a technique for explaining situations in an ordered list where later items build upon concepts introduced earlier. This makes it easy for the user to identify the first "stucking point" — the first item they don't understand.

### Format
- Ordered list (numbered)
- Each item introduces or uses concepts from earlier items
- Progressive complexity
- Self-contained where possible

### Purpose
- Quickly surface gaps in understanding
- Enable targeted clarification
- Reduce back-and-forth by pinpointing confusion

### Example Usage
When explaining a technical concept (e.g., TurboRepo, module system, architecture), use PEX format so the user can say "I understand items 1-5, but item 6 is where I get stuck."