# Plan: Refactor `suggest.ts` — 3 Parallel Probing Directions

## Overview

Replace the current single linear exploration loop in `suggest.ts` with **3 concurrent fire-and-forget probing directions** (wiki, skill, mindmap), each in its own file under `suggest/`. Each runs a 3-phase pipeline: **probe → solve → format**.

**Key change:** The orchestrator (`suggest.ts`) is non-async — it fires 3 async functions without awaiting them. Each direction handles its own errors internally.

---

## File Structure

```
src/loop/states/
  suggest.ts                 ← Orchestrator (non-async, fires 3 directions)
  suggest/
    brown-bag.ts             ← Shared: BrownBag types, tryExtractBrownBag, formatBrownBag
    probe-utils.ts           ← Shared: mergeIntoLastUserMessage, runProbe
    wiki.ts                  ← Wiki direction: probe prompt → solve loop → mail
    skill.ts                 ← Skill direction: probe prompt → solve loop → mail
    mindmap.ts               ← Mindmap direction: probe prompt → solve loop → mail
```

---

## Architecture

```
runSuggestBackground(env) ← non-async
│
├── fork: baseMessages = [...triologue.getMessages()]
├── guard: last message role must be 'user'
├── fetch domains, tools
│
├── runWikiDirection(...)     ← fire-and-forget (async, no await)
├── runSkillDirection(...)    ← fire-and-forget (async, no await)
├── runMindmapDirection(...)  ← fire-and-forget (async, no await)
│
└── Each direction:
      Phase 1 ── PROBE ──→ signal (concise text, no tools called by LLM)
      Phase 2 ── SOLVE ──→ brownbag JSON (max 10 tool calls, 1 tool)
      Phase 3 ── FORMAT ──→ mail via appendMail
```

---

## Phase 1: Probe (Summarize Triologue into a Signal)

### Shared: `probe-utils.ts`

```typescript
function mergeIntoLastUserMessage(msgs: Message[], prompt: string): Message[] | null
function runProbe(baseMessages, probePrompt, allTools, stopRequested, isNeglected): Promise<string | null>
```

- **mergeIntoLastUserMessage**: Copy-on-write — shallow copy array, replace last element with new object. Returns null if last role is not `'user'`.
- **runProbe**: Calls `retryChat` with full tool list (preserve prompt cache), but prompt says *"Output text only, do NOT use tools"*. Returns the signal text or null.

### Wiki Probe Prompt (`wiki.ts`)

> Analyze conversation → extract:
> 1. Already-loaded wiki docs (to skip)
> 2. New topics within registered domains not yet searched in wiki

### Skill Probe Prompt (`skill.ts`)

> Analyze conversation → extract:
> - Keywords capturing user's mindflow / conceptual thread

### Mindmap Probe Prompt (`mindmap.ts`)

> Analyze conversation → extract:
> 1. Already-recalled mindmap paths
> 2. User interests outside those paths

---

## Phase 2: Solve (Explore with 1 Tool → Brownbag)

### Each direction's solve loop

- Takes the signal from probe
- Builds solve messages: `[assistant(signal), user(solvePrompt)]`
- Provides **exactly 1 tool** to `retryChat` (e.g., `wiki_get`, `skill_load`, `recall`)
- Loop: max 10 turns
  - Tool calls → execute via `loader.execute()`
  - No tool calls → extract brownbag JSON from text
- Skill direction uses specialized extraction with hallucination detection via `loader.getSkill()`

### Solve Prompts

**Wiki:** Use `wiki_get` only, produce `{ originalQuery, wikiNotes }`
**Skill:** Use `skill_load` only with `intent` param, produce `{ originalQuery, skills }`
**Mindmap:** Use `recall` only, start with `recall(path="/")`, produce `{ originalQuery, mindmapPaths }`

---

## Phase 3: Format (Brownbag → Mail)

### `brown-bag.ts`

- `tryExtractBrownBag(content, validateSkills?)` → `{ ok, bag } | { ok, feedback }`
- `formatBrownBag(bag)` → mail body string or null
- `BrownBag` interface: `originalQuery`, `wikiNotes`, `skills`, optional `mindmapPaths`
- **`title` field removed**

### Mail Delivery

```typescript
env.ctx.mail.appendMail('suggest', `Brown Bag (${directionName})`, body);
```

---

## Orchestrator (`suggest.ts`)

### Key design decisions

- **Non-async**: `runSuggestBackground` returns `void`. It fires 3 async functions without awaiting.
- **Error handling**: Each direction catches its own errors internally — no unhandled rejections.
- **Stop mechanism**: `env.runningSuggest.stop()` sets timestamp flag. Each direction checks `stopRequested()` before each iteration/tool.
- **Domain fetch**: Uses `ctx.wiki.listDomains()` in a `.then()` chain — fires directions after domains are ready.
- **Cleanup**: The `.finally()` block clears `env.runningSuggest` only if the runId still matches (guard against handle corruption).

### Changes to `prompt.ts`

`runSuggestBackground(env)` no longer returns a Promise, so the `.catch()` call is removed. Each direction already handles its own errors.

---

## Constraints

| Concern | Solution |
|---------|----------|
| Prompt cache | Keep full tool list during probe, don't filter |
| Triologue parity | Merge into last user msg via copy-on-write |
| Original pollution | Shallow copy array, replace last element |
| Safety guard | Skip direction if last msg role is not `'user'` |
| Tool restriction | Provide exactly 1 tool to `retryChat` |
| Stop on new prompt | `env.runningSuggest.stop()` called by PROMPT handler |
| Each direction self-contained | Separate file per direction, no shared state |

## Edge Cases

- **No wiki domains**: wiki direction skips or produces empty brownbag
- **No mindmap**: recall returns error, direction handles it
- **Fire-and-forget concurrency**: each direction runs independently; one failing doesn't stop others
- **Hallucinated skills**: skill direction validates against `loader.getSkill()` and provides feedback
- **Stop/restart**: `runId` pattern prevents handle corruption
- **Last message not 'user'**: entire suggest phase skips early
