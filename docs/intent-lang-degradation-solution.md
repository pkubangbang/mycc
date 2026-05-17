# Intent Language Degradation Under Long Context

## Problem

The intent language (`VERB OBJECT TO PURPOSE`) is a structured DSL that the LLM must use when calling `bash`. Its format rules (valid verbs, objects, purpose clause) are documented in `buildIntentLanguageSection()` and injected into the system prompt via `buildCommonSections()`.

As the conversation grows past ~30 messages, the LLM's attention mechanism degrades. The system prompt — including the intent language table — is pushed out of the effective attention window. The LLM begins producing malformed intent strings:

- Unknown verbs (`SEARCH SOURCE TO ...`)
- Missing `TO` clauses (`READ SOURCE`)
- Unknown objects (`READ FILE TO ...`)
- Missing intent parameter entirely

Each failure returns an error message with a hint for the correct format. The LLM *should* read the hint and retry correctly. But when attention is degraded, it can't even parse the hint — producing another malformed intent. This loops until confusion index reaches 10 and a hint round fires, but a hint won't fix attention degradation.

## Observation

Intent validation failures are a **direct attention-degradation signal** — more specific than raw token count because they show the LLM is literally failing to attend to its own system prompt. Two failures may be normal recovery (fail → read hint → correct). Three consecutive failures mean the LLM can't read the hint either — it's truly trapped.

## Solutions Considered

### Approach A: Detect in Hint Round, Escalate to Compaction

The hint round already fires when confusion index >= 10 and message count >= 6. We extend it: if the confusion was caused by intent language failures AND the message count is large (>= 20), skip the hint injection and trigger `triologue.compact()` directly.

**Flow:**
```
COLLECT → confusion >= 10 → generateHintRound()
  → detect intent trap? → compact() → COLLECT (fresh context)
  → normal?            → inject HINT note → LLM → ...
```

**Pros:**
- Uses existing infrastructure (hint round trigger, confusion index)
- Conservative — only fires after sustained confusion
- Detection logic is simple (scan tool results for intent-failure substrings)

**Cons:**
- Latency: must wait for confusion index to reach 10
- The hint round LLM call is wasted if answer is "compact"
- Detection runs in COLLECT state, one layer removed from the actual tool execution

### Approach B: Hook System (Chosen)

Add a `compact` action type to the hook system. A hookish skill fires on every `bash` trigger. Its condition checks for 3+ intent failures and large context. When matched, compaction happens immediately — no confusion index gate, no wasted LLM call.

**Flow:**
```
HOOK → bash trigger → eval condition
  → countResult('[Intent]') >= 3 && totalCount() > 20
  → compact action → compact() → COLLECT (fresh context)
  → no match → proceed to TOOL execution
```

**Pros:**
- Fires at the right moment (before bash execution, in HOOK state)
- Surgical — targets bash specifically
- No wasted LLM call for hint analysis
- `compact` action is reusable for future attention-degradation patterns
- Detection is in code (substring match), not delegated to an LLM

**Cons:**
- Requires new infrastructure: `compact` action type, `countResult()` Sequence method
- 3 new/changed files vs 1 for the hint-round approach

### Why Hook Wins

The hook system is the right layer for this. It already inspects tool calls before execution, evaluates conditions against conversation history, and modifies the pending call list. Adding `compact` as an action fits naturally — it's the most severe intervention (clear the whole context) at the highest priority (0, before `block`).

The hint-round approach is simpler to implement but puts the detection logic at the wrong layer. By the time confusion reaches 10, the LLM has already been degrading for several turns — producing not just bad intents but potentially bad file paths, bad logic, bad edits. The hook catches the first unambiguous signal and acts immediately.

## Implementation

See the plan file: `~/.claude/plans/i-found-that-due-logical-church.md`

### Files Changed

| File | Change |
|------|--------|
| `src/context/grant/intent-parser.ts` | Prefix error messages with `Error: [Intent] ` |
| `src/hook/sequence.ts` | Add `countResult(pattern)` method |
| `src/hook/conditions.ts` | Add `compact` to `HookAction` type and `CONDITION_SCHEMA` |
| `src/hook/condition-validator.ts` | Add `'compact'` to `VALID_ACTION_TYPES` |
| `src/hook/hook-executor.ts` | Add compact handler, update `HookResult` and `ProcessToolCallsResult` |
| `src/loop/states/hook.ts` | Handle `compactRequested` from hook result |

### New Files

| File | Purpose |
|------|---------|
| `.mycc/skills/compact-on-intent-trap.md` | Hookish skill definition |
| `.mycc/conditions.json` | Updated with compiled condition (via `skill_compile`) |

## Configuration

- `INTENT_TRAP_THRESHOLD = 3` — consecutive intent failures before triggering compaction
- `MIN_TOTAL_TOOLS_FOR_COMPACT = 20` — minimum total tool calls before compaction is considered (prevents false positives in short sessions)
