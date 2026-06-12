# Skill Visibility: How Skills Are Exposed to the LLM & How Hooks Intercept

> **Date:** 2026-06-12
> **Context:** Documentation of the skill system's visibility mechanism — skills are loaded into the harness but not revealed to the LLM; they are discoverable only on-demand via search.

## Core Principle

Skills are **loaded but opaque** — the LLM knows skills *exist* and *how to use them*, but does **not** know what specific skills are available until it searches.

## Three Layers of Skill Storage

| Layer | Path | Priority |
|-------|------|----------|
| **User** | `~/.mycc-store/skills/` | Lowest (overridable) |
| **Project** | `.mycc/skills/` | Middle (shadows user) |
| **Built-in** | `<package_root>/skills/` | Highest (cannot be shadowed) |

Skills are loaded in order: user → project → built-in. Built-in skills win on name conflict.

## How Loading Works

1. **At startup** (`Loader.loadAll()` via `src/context/shared/loader.ts`):
   - All `.md` files from all 3 layers are parsed with `gray-matter` (YAML frontmatter)
   - Parsed into `Skill` objects with `{ name, description, keywords, content, when, sourceFile }`
   - Stored in `Loader.skills: Map<string, SkillEntry>`
   - Each skill is also indexed into the wiki under the `"skills"` domain for semantic search

2. **Legal entrypoint formats**:
   - Root level: `{dir}/*.md` — any `.md` file is a valid skill
   - Subdirectory: `{dir}/{name}/SKILL.md` — only `SKILL.md` in a folder

3. **Hot-reload**: Project-level skills in `.mycc/skills/` are watched via `fs.watch` with 300ms debounce. Changes are picked up automatically.

## What the LLM Sees

### In the System Prompt (`src/loop/agent-prompts.ts`)

The LLM is told about skills in the **Knowledge Boundary** section:

> *"**Skills**: Specialized knowledge for specific tasks. Use `skill_search(search="...")` to discover relevant skills."*

This tells the LLM:
- ✅ Skills exist
- ✅ How to discover them (`skill_search`)
- ✅ How to load them (`skill_load`)

### What is NOT in the System Prompt

- ❌ No skill names are listed
- ❌ No skill descriptions or keywords are injected
- ❌ No skill content is pre-loaded

## The Two Skill Tools

### `skill_search` (`src/tools/skill_search.ts`)

- **Scope:** `['main', 'child']` — available to lead and teammates
- **Search method:** Dual-path:
  1. **Semantic search** via wiki embeddings (cosine similarity against `"skills"` domain)
  2. **Name/keyword matching** — fuzzy match against loaded skill names and keywords
- **Returns:** Skill names, descriptions, match percentages (for semantic), and keywords (for name match). **Content is NOT included** — only metadata.
- **Threshold:** Configurable via `getSkillMatchThreshold()` in env config

### `skill_load` (`src/tools/skill_load.ts`)

- **Scope:** `['main', 'child']`
- **Matching:** Exact match first, then fuzzy (case-insensitive, normalize hyphens/underscores)
- **Returns:** Full skill content (name, description, keywords, when, and the markdown body)
- **Side effect:** Re-indexes the skill to wiki after loading (best-effort, silently fails if no embedding model available)

## Visibility Flow Diagram

```
LLM knows about skills
        │
        ▼
  skill_search("keywords")
        │
        ├──> Wiki semantic search (embeddings)
        └──> Name/keyword fuzzy matching
        │
        ▼
  Returns: [name + description + match info]  ← NO CONTENT
        │
        ▼
  skill_load(name="exact_name")
        │
        ▼
  Returns: FULL content (including markdown body)
```

## Why This Design?

1. **Context efficiency** — Skills can be large (thousands of chars). Loading all skills upfront would overflow the token budget. On-demand loading ensures only relevant knowledge occupies context.

2. **Scalability** — Users can add many skills (built-in, project, user layers) without worrying about the system prompt growing unbounded.

3. **Relevance filtering** — Semantic search acts as a smart filter: only skills semantically related to the current task get loaded, reducing noise.

4. **Layered override** — The 3-layer system (user/project/built-in) allows progressive customization without the LLM needing to know about overrides.

## Key Files

| File | Role |
|------|------|
| `src/context/shared/loader.ts` | Loads skills from disk, manages the skill map, indexes to wiki |
| `src/tools/skill_search.ts` | Tool for searching skills by keywords/semantics |
| `src/tools/skill_load.ts` | Tool for loading full skill content |
| `src/utils/skill-path-resolver.ts` | Path resolution for 3 skill layers |
| `src/slashes/skills.ts` | `/skills` and `/skills build` slash commands |
| `src/loop/agent-prompts.ts` | System prompt — tells LLM about skill_search/skill_load |
| `src/context/parent-context.ts` | Wiring: `ctx.skill = loader` (the SkillModule interface) |

## The Hook System: Proactive Skills That Intercept LLM Output

### Your Intuition

> *"Since the harness has loaded all the skills, it also has enabled all the hooks. So after the LLM has generated the response, the hook system will have the chance to intercept."*

This is **essentially correct**, with one important qualification about compilation.

### How Hooks Work End-to-End

#### 1. Skill Load → Hook Registration (Partial)

When a skill is loaded (at startup or via `/skills build`), the **loader** is synced with the **ConditionRegistry**:

```ts
// In src/hook/conditions.ts
syncPending(loader): string[] {
  const skills = loader.listSkills();
  for (const skill of skills) {
    if (skill.when && !this.conditions.has(skill.name)) {
      this.pending.add(skill.name);  // Marked as "needs compilation"
    }
  }
}
```

A skill with a `when` field is **not auto-compiled**. It's just marked as "pending". The harness knows a hook-candidate *exists*, but the hook is **not active** until `skill_compile` is called.

#### 2. Compilation: Skills → Active Hooks

`skill_compile(name="lint-after-edit")` translates the natural language `when` field into a structured condition using an LLM call with JSON schema enforcement:

```ts
interface Condition {
  trigger: string[];     // e.g. ["git_commit", "stop"]
  when: string;          // Original "when" text
  condition: string;     // Compiled expression e.g. "seq.hasAny(['edit_file','write_file']) && seq.lastIndexOf('bash#lint') == -1"
  action: HookAction;    // { type: "inject_before", tool: "bash", args: { command: "pnpm lint", ... } }
  version: number;
  sourceFile?: string;   // Path to skill file (for orphan detection)
}
```

The result is atomically saved to `.mycc/conditions.json`. On subsequent startups, `ConditionRegistry.load()` reads this file and registers all hooks into memory from the persisted JSON.

#### 3. The Interception Point: HOOK State

The state machine (`src/loop/state-machine.ts`):

```
LLM ───► HOOK ──► { TOOL (has calls) | STOP (no calls) }
```

In the **HOOK state** (`src/loop/states/hook.ts`), the system intercepts **after** the LLM has generated a response but **before** any tool is executed:

```
LLM responds with { content, tool_calls }
          │
          ▼
    HOOK state handler
          │
          ├── 1. Augment calls with metadata (file path, LOC, destructiveness)
          ├── 2. For each tool call:
          │       - Call ConditionRegistry.matches(trigger, sequence)
          │       - Condition evaluates against conversation history (Sequence)
          │       - If true: execute the HookAction
          │
          ├── Actions:
          │   ├── block        → Reject the call, return error to LLM
          │   ├── replace      → Modify the call (different tool/args)
          │   ├── inject_before→ Insert new call before the trigger
          │   ├── inject_after → Insert new call after the trigger
          │   ├── message      → Inject a hint note (weakest)
          │   └── compact      → Force context compaction (highest priority)
          │
          └── 3. Modified calls → TOOL state for actual execution
```

### The Full Flow Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                    SKILL LIFECYCLE                            │
│                                                              │
│  Start: skills/*.md loaded → loader.skills Map               │
│         │                                                    │
│         ├── Skill has "when"?                                │
│         │   ├── Yes → conditions.syncPending() marks pending │
│         │   └── No  → passive skill (search-only, no hook)   │
│         │                                                    │
│         └── Pending skill → skill_compile tool called        │
│                 │                                            │
│                 ▼                                            │
│         LLM compiles "when" → Condition (JSON schema)        │
│                 │                                            │
│                 ├── Saved to .mycc/conditions.json            │
│                 └── Loaded into ConditionRegistry in-memory   │
│                                                              │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│                 RUNTIME INTERCEPTION                          │
│                                                              │
│  User says: "fix this bug and commit"                        │
│         │                                                    │
│         ▼                                                    │
│  COLLECT → LLM → generates tool calls                        │
│         │         e.g. [read_file, edit_file, bash, commit]  │
│         ▼                                                    │
│  ╔═══ HOOK state ═══════════════════════════════════════╗    │
│  ║   For each tool call:                               ║    │
│  ║                                                      ║    │
│  ║   read_file   → no matching hooks → proceed         ║    │
│  ║   edit_file   → no matching hooks → proceed         ║    │
│  ║   bash('pnpm lint') → no matching hooks → proceed   ║    │
│  ║   git_commit → matches "lint-after-edit" hook       ║    │
│  ║     │                                                ║    │
│  ║     ├── Check: seq.hasAny(['edit_file','write_file'])?║   │
│  ║     │     → true (we edited files this turn)         ║    │
│  ║     ├── Check: seq.lastIndexOf('bash#lint')?         ║    │
│  ║     │     → NOT -1 (lint was already run)            ║    │
│  ║     └── Result: condition false → PROCEED            ║    │
│  ║                                                      ║    │
│  ║   ← All hooks checked → proceed to TOOL state       ║    │
│  ╚══════════════════════════════════════════════════════╝    │
│         │                                                    │
│         ▼                                                    │
│  TOOL state → Execute all modified tool calls                │
└──────────────────────────────────────────────────────────────┘
```

### What Sequences Can Evaluate

The `Sequence` class (`src/hook/sequence.ts`) provides these functions for condition expressions:

| Function | Purpose | Example |
|----------|---------|---------|
| `seq.has(tool)` | Tool called this turn? | `seq.has('edit_file')` |
| `seq.hasAny([...])` | Any of these tools called? | `seq.hasAny(['edit_file', 'write_file'])` |
| `seq.lastIndexOf(pattern)` | Position of last occurrence (supports `bash#cmdPat`) | `seq.lastIndexOf('bash#lint')` |
| `seq.last(tool?)` | Last event (optionally filtered) | `seq.last()?.result` |
| `seq.lastError()` | Last error event | `seq.lastError()` |
| `seq.count(tool?)` | Count this turn | `seq.count('bash') > 3` |
| `seq.totalCount(tool?)` | Count entire session | `seq.totalCount('git_commit')` |
| `seq.countResult(tool, pat, max?)` | Count results matching substring | `seq.countResult('bash', 'Error', 20) >= 3` |
| `seq.since(tool)` | Events since last occurrence | `seq.since('bash#lint').length` |
| `seq.sinceEdit()` | Events since last file edit | `seq.sinceEdit().length === 0` |
| `seq.isPlanMode()` | Is agent in plan mode? | `!seq.isPlanMode()` |
| `call.metadata.filePath` | Current call's file path | `call.metadata.filePath.includes('/tests/')` |
| `call.metadata.newLoc` | New file line count | `call.metadata.newLoc > 300` |
| `call.metadata.isDestructive` | Is bash destructive? | `call.metadata.isDestructive` |
| `call.args.command` | Current bash command | `call.args.command.includes('main')` |

### Key Nuances

1. **Compilation is NOT automatic** — Skills with `when` are detected as "pending" but require an explicit `skill_compile` call to activate. Until then, they're just passive skills.

2. **Conditions are persisted** — Once compiled, conditions are saved to `.mycc/conditions.json` and auto-loaded on restart. No re-compilation needed.

3. **Turn-bounded** — `Sequence.events` (the current turn) is cleared on each new user query. Session-wide counts use `totalEventsCount` and `toolCallTally`.

4. **Execution order matters** — Hooks run on the entire delta of tool calls from one LLM response. inject_before/after can change the array; subsequent hooks in the same pass see the modified array.

5. **Deduplication** — The `HookExecutor.injectedThisMove` set prevents the same hook from re-triggering within one LLM response.

### Key Files (Hook System)

| File | Role |
|------|------|
| `src/hook/conditions.ts` | ConditionRegistry — persists, loads, compiles conditions |
| `src/hook/sequence.ts` | Sequence — tracks tool calls, provides query functions |
| `src/hook/evaluator.ts` | AST-based expression evaluator (jsep, no Function constructor) |
| `src/hook/hook-executor.ts` | Executes hook actions (block/replace/inject/message/compact) |
| `src/hook/hook-preprocessor.ts` | Augments tool calls with metadata (file path, LOC, destructive) |
| `src/hook/condition-validator.ts` | Validates compiled conditions before persistence |
| `src/loop/states/hook.ts` | HOOK state handler — registered in state machine |
| `src/loop/state-machine.ts` | State machine: COLLECT → LLM → HOOK → {TOOL \| STOP} |

## Closing the Gap: Pending Hook Visibility

### The Problem

Currently, when a fresh mycc installation starts:

1. Skills with `when` fields are loaded into `loader.skills` 
2. `conditions.syncPending(loader)` marks them as needing compilation
3. **The LLM has zero awareness** of these pending hooks until a hint round fires (which only happens when confusion is detected)
4. The hint round just lists names — no descriptions, no actionable guidance

**Result:** The LLM doesn't know what proactive hooks it *could* have. There's a discovery gap.

### The Fix

Inject pending hook information into the triologue's `projectContext` at startup, so the LLM always sees it (just like README.md and mindmap instructions).

#### Implementation Plan

##### 1. `src/loop/triologue.ts` — Add `setPendingHooksInfo()`

A new method that formats pending skills into a user+assistant pair and pushes them into `projectContext`:

```
[Hooks Pending] The following skills have "when" conditions that can be 
compiled into proactive hooks. They are NOT active yet.

- lint-after-edit: Run lint checks after editing code files
  When: after editing code, run lint before commit
  Use: skill_compile(name="lint-after-edit")

- test-after-edit: Run tests after editing code files  
  When: after editing code, run tests before commit
  Use: skill_compile(name="test-after-edit")

Not all need to be compiled upfront. Compile only those relevant 
to your current task.
```

##### 2. `src/loop/agent-repl.ts` — Call the new method

After `conditions.syncPending(loader)` (line 257), add logic to gather pending skills from the loader and inject them:

```ts
const pendingSkillNames = conditions.getPending();
if (pendingSkillNames.length > 0) {
  const pendingSkills = pendingSkillNames
    .map(name => loader.getSkill(name))
    .filter((s): s is Skill => !!s);
  triologue.setPendingHooksInfo(pendingSkills);
}
```

#### Files Changed

| File | Change | Reason |
|------|--------|--------|
| `src/loop/triologue.ts` | Add `setPendingHooksInfo()` | New projectContext injection point |
| `src/loop/agent-repl.ts` | Call it after `syncPending` | Actually inject at startup |

#### What Stays the Same

- `conditions.syncPending()` / `conditions.getPending()` — unchanged
- The hint round notification — still fires, still lists pending skills as backup
- The `skill_compile` tool — unchanged
- All hook evaluation logic — unchanged

#### Key Design Decision

Using `projectContext` (not a HINT/REMINDER note that scrolls away) ensures the info is **always visible** to the LLM in every turn, right alongside README.md and mindmap instructions. It's zero-cost (no LLM calls, just string formatting).