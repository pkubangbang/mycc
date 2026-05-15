# SUGGEST State and Brown Bag

## Overview

The **SUGGEST** state is a background task that runs in parallel with the COLLECT state. Its purpose is to proactively discover relevant wiki notes and skills for the user's query, packaging them into a **"brown bag"** that the LLM receives in the next conversational turn.

This solves a key limitation: skills are uncountable (we cannot list them all — the list would overflow context), so the LLM needs guided exploration to discover which ones are relevant.

## Design Principles

### 1. Fire-and-forget, killed on next turn

SUGGEST runs as a background promise. It is **never awaited** in the COLLECT→LLM pipeline. When the user submits new input (PROMPT state), the SUGGEST from the previous turn is gracefully stopped.

### 2. Prompt cache preserved

The system prompt is **never altered at runtime**. The suggest-mode rules are baked statically into `buildNormalModePrompt()`:

> When the user says "[REMINDER] you are in the suggest mode", you will enter a restricted discovery mode...

At runtime, the SUGGEST handler simply appends a user message `[REMINDER] you are in the suggest mode` to the forked triologue. The full tool list is always sent (no filtering), preserving the Ollama prompt cache. Disallowed tools return an error from a dedicated executor instead of being removed from the tool list.

### 3. Brown bag delivered via mailbox

The SUGGEST output is mailed to the lead agent using the existing mailbox system (`ctx.mail.appendMail('suggest', 'Brown Bag', content)`). The next turn's COLLECT state automatically collects it through the standard mail pipeline — no special extraction logic needed.

### 4. Explorer-agent loop pattern

The SUGGEST loop follows the same pattern as `src/mindmap/explorer-agent.ts`:

```
if tool_calls → execute (with restricted executor returning errors for disallowed tools) → continue
if no tool_calls → try to extract brown bag → mail on success / loop again on failure
```

Max 10 turns. If exhausted without a valid brown bag, the last assistant message is used as a best-effort extraction.

## Graceful Stop Mechanism

To handle rapid stop/restart cycles (e.g., future auto-reply), SUGGEST uses a **timestamp-based stop flag**:

```
let stopRequestedAt: number | null = null;

env.runningSuggest = {
  stop: () => { stopRequestedAt = Date.now(); }
};
```

The loop captures `stopRequestedAt` at the start of each iteration and after each LLM call. If it has changed (or become non-null), the loop exits. Each new SUGGEST run creates a fresh closure with its own `stopRequestedAt = null`, so rapid stop/restart is unambiguous.

## Brown Bag Format

The LLM outputs the brown bag as **uncomplicated JSON**:

```json
{
  "originalQuery": "the user's original query",
  "wikiNotes": ["specific query for wiki_get", "another query"],
  "skills": ["exact-skill-name-1", "exact-skill-name-2"]
}
```

All three fields are required strings/arrays.

`tryExtractBrownBag` parses this JSON and produces a **print-formatted mail body**:

```
[Brown Bag]

Original query: <originalQuery>

Wiki notes to search:
- "specific query for wiki_get"
- "another query"

Skills to load: exact-skill-name-1, exact-skill-name-2
```

This human-readable format is what gets passed to the LLM in the next turn's COLLECT as a mail message.

## Data Flow

```
Turn N:
  PROMPT ──► env.runningSuggest?.stop()   (kill previous SUGGEST)
       ──► COLLECT ──► collects all mails (including brown bag from Turn N-1)
                    ──► env.runningSuggest?.stop() + runSuggestBackground()
       ──► LLM ──► HOOK ──► TOOL ──► ... ──► PROMPT

  [Background SUGGEST (Turn N):]
    1. Fork triologue (deep copy raw messages)
    2. Append "[REMINDER] you are in the suggest mode"
    3. Run explorer loop (max 10 turns):
       ┌─ tool_calls? → restricted executor → continue
       └─ no tool_calls? → parse JSON brown bag → mail on success / loop on fail
    4. ctx.mail.appendMail('suggest', 'Brown Bag', formattedBrownBag)

Turn N+1:
  PROMPT ──► env.runningSuggest?.stop()
       ──► COLLECT ──► collects "Mail from suggest: Brown Bag\n..." (standard pipeline)
                    ──► fires new SUGGEST
       ──► LLM (now has brown bag hints from Turn N)
```

## Tool Restriction

SUGGEST does NOT filter the tool list sent to the LLM — this would invalidate the prompt cache. Instead, it uses a dedicated executor (`executeSuggestTool`) that:

| Tool | Behavior |
|------|----------|
| `read_file`, `bash`, `wiki_get`, `skill_load`, `recall` | Execute normally via `loader.execute()` |
| All other tools | Return error: `"Tool X is not available in suggest mode. You may only use: read_file, bash, wiki_get, skill_load, recall. Continue exploring with allowed tools."` |

## Files

| File | Role |
|------|------|
| `src/loop/state-machine.ts` | `AgentState.SUGGEST` in enum. `MachineEnv.runningSuggest` for stop handle. |
| `src/loop/agent-prompts.ts` | Suggest-mode rules baked into `buildSoloNormalPrompt()` and `buildTeamNormalPrompt()`. |
| `src/loop/states/suggest.ts` | `runSuggestBackground(env)` — fork triologue, explorer loop, mail brown bag. `handleSuggest()` — state handler stub. |
| `src/loop/states/collect.ts` | Stops previous SUGGEST, fires new `runSuggestBackground()`. |
| `src/loop/states/prompt.ts` | Calls `env.runningSuggest?.stop()` on entry. |
| `src/loop/agent-repl.ts` | Registers `handleSuggest` in handler map. |

## Error Handling

SUGGEST is **best-effort**. All errors are caught silently and logged via `ctx.core.verbose()`. If SUGGEST fails, the main turn proceeds normally — the brown bag is simply absent, and the LLM works without suggested context. No brown bag is strictly better than a wrong one.

ESC (neglected mode) is also checked: if the user presses ESC during a SUGGEST LLM call, the loop exits without mailing a brown bag.
