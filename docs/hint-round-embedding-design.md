# Embedding-Based Duplication Detection for Hint Round

## Problem

The current hint round system uses a simple **confusion index** (0-20) based on:
- Tool classification (exploration vs action)
- Repetition of the same tool in the last 5 calls
- Error results

The "same tool repetition" heuristic is coarse — it cannot detect **semantic duplication** where the agent makes different tool calls with the same underlying intent (e.g., reading different files to answer the same question, or running different bash commands to debug the same issue).

## Solution

Introduce a **`RequestEmbeddingTracker`** that maintains an in-memory rolling window of the last 20 agent tool calls, converts each into an embedding vector via Ollama's existing `getEmbedding()`, and computes cosine similarity to detect semantic duplication. The max similarity is mapped to a delta of +0 to +2 and added to the confusion index.

The old "same tool name in last 5 calls" repetition heuristic is **removed entirely** from the lead agent's `tool.ts` — the embedding-based approach subsumes it.

## Design

### 1. New Module: `src/loop/request-embedding.ts`

```typescript
interface TrackedEntry {
  text: string;          // Text representation of the tool call (≤1000 chars)
  embedding: number[];   // Embedding vector (from Ollama)
  tool: string;          // Tool name
  timestamp: number;     // When the call was made
}

class RequestEmbeddingTracker {
  private buffer: TrackedEntry[] = [];
  private readonly MAX_SIZE = 20;
  private readonly MAX_TEXT_LENGTH = 1000;

  /**
   * Add a tool call to the rolling buffer.
   * Generates embedding for the text representation.
   * If getEmbedding() fails (Ollama down), catches silently and skips.
   */
  async addEntry(toolName: string, args: Record<string, unknown>): Promise<void>

  /**
   * Build a text representation of a tool call for embedding.
   * Format: "tool_name: key1=value1, key2=value2"
   * Truncated to MAX_TEXT_LENGTH (1000 chars).
   * Long values (file contents) are truncated to first 200 chars.
   */
  private buildText(toolName: string, args: Record<string, unknown>): string

  /**
   * Find the maximum cosine similarity between the latest entry
   * and all previous entries in the buffer.
   * Returns 0 if buffer has fewer than 2 entries.
   */
  getMaxSimilarity(): number

  /**
   * Map a similarity score (0.0–1.0) to a confusion delta (0–2).
   *   < 0.7  → 0 (no significant similarity)
   *   0.7–0.85 → +1 (moderate similarity)
   *   > 0.85 → +2 (high similarity — likely stuck in a loop)
   */
  similarityToDelta(similarity: number): number

  /**
   * Clear the buffer (e.g., after auto-compact).
   */
  clear(): void
}
```

#### Text Representation for Embedding

The text representation of a tool call is built as:
```
tool_name: key1=value1, key2=value2, ...
```

Rules:
- For `bash` commands, the `command` arg is included directly.
- For `read_file`, the `path` is included.
- For `edit_file`/`write_file`, the `path` is included but content is truncated to first 200 chars to avoid noise.
- The final string is truncated to 1000 chars max (Ollama embedding limit).

This ensures that:
- Same tool + same args → near-identical embedding → high similarity
- Same tool + different but related args → similar embedding → moderate similarity
- Different tools with same intent (e.g., `read_file` + `grep` for the same topic) → similar embedding

#### Similarity Detection Algorithm

When `addEntry()` is called:
1. Build text representation (≤1000 chars)
2. Generate embedding via `getEmbedding(text)`
3. Add to rolling buffer (evict oldest if > 20)
4. Compute cosine similarity against all previous entries
5. Store the max similarity score

`getMaxSimilarity()` returns the highest similarity found among any pair in the buffer.

### 2. Integration in `src/loop/states/tool.ts` — Confusion Scoring Replacement

**BEFORE** (old repetition heuristic — to be removed):
```typescript
// Confusion scoring based on tool classification
if (!EXPLORATION_TOOLS.has(toolName)) {
  const recentTools = sequence.getEvents().slice(-5).map(e => e.tool);
  const isRepetition = recentTools.includes(toolName);

  if (toolName === 'bash') {
    const cmd = String(toolCall.function.arguments?.command || '');
    if (!READ_ONLY_BASH.test(cmd)) {
      if (isRepetition) {
        ctx.core.increaseConfusionIndex(1);
      } else {
        ctx.core.increaseConfusionIndex(-1);
      }
    }
  } else if (ACTION_TOOLS.has(toolName)) {
    if (isRepetition) {
      if (toolName === 'mail_to') {
        ctx.core.increaseConfusionIndex(2);
      } else {
        ctx.core.increaseConfusionIndex(1);
      }
    } else {
      ctx.core.increaseConfusionIndex(-1);
    }
  }
}
```

**AFTER** (embedding-based):
```typescript
// Semantic duplication detection via embedding similarity
// Replaces the old "same tool name in last 5 calls" heuristic
if (!EXPLORATION_TOOLS.has(toolName)) {
  const maxSim = env.requestEmbeddingTracker.getMaxSimilarity();
  const delta = env.requestEmbeddingTracker.similarityToDelta(maxSim);
  if (delta > 0) {
    ctx.core.increaseConfusionIndex(delta);
  } else {
    // No semantic duplication — progress is being made
    ctx.core.increaseConfusionIndex(-1);
  }
}
```

The `addEntry()` call happens **before** this scoring block, so `getMaxSimilarity()` reflects the latest entry's comparison against all previous entries.

**Error results still add +2** (unchanged).

### 3. Integration in `src/loop/states/collect.ts`

No change needed here — the confusion index already drives the hint round trigger. The embedding-based scoring feeds into the same confusion index, so the existing `confusionIndex >= CONFUSION_THRESHOLD` check works automatically.

### 4. Integration in `src/loop/hint-round.ts`

Include the duplication report in the hint round context for richer LLM analysis:

```typescript
// In the userPrompt, add:
const dupReport = env.requestEmbeddingTracker.getDuplicationReport();
if (dupReport) {
  userPrompt += `\n## Duplication Analysis\n${dupReport}\n`;
}
```

### 5. Integration in `src/loop/state-machine.ts`

Add the tracker to `MachineEnv`:

```typescript
export interface MachineEnv {
  // ... existing fields ...
  requestEmbeddingTracker: RequestEmbeddingTracker;
}
```

Initialize in `AgentStateMachine` constructor.

### 6. Reset Behavior

- **After hint round**: The tracker is NOT cleared — the rolling buffer persists so the next hint round can see the full picture.
- **After auto-compact**: The tracker IS cleared (via `clear()`) since the conversation context has been summarized and the confusion index is reset.
- **On new user query (PROMPT state)**: The tracker is NOT cleared — we want to detect duplication across turns.

## Files Changed

| File | Change |
|------|--------|
| `src/loop/request-embedding.ts` | **NEW** — `RequestEmbeddingTracker` class (~100 lines) |
| `src/loop/state-machine.ts` | Add `requestEmbeddingTracker` to `MachineEnv` |
| `src/loop/states/tool.ts` | Replace old repetition heuristic with embedding-based scoring; add `addEntry()` call |
| `src/loop/hint-round.ts` | Include duplication report in hint context |
| `src/loop/agent-repl.ts` | Instantiate tracker and pass to state machine |

## Dependencies

- `src/engine/ollama-embedding.ts` — already exists, provides `getEmbedding()`
- Cosine similarity — implemented inline in the tracker (simple math, no external dep)

## Assumptions

1. **Ollama is always available for embeddings** — The project already requires Ollama for embeddings (even with DeepSeek provider). This is a safe assumption.
2. **Embedding generation is fast** — `getEmbedding()` is a single API call to local Ollama. The overhead per tool call is acceptable (typically <100ms).
3. **nomic-embed-text dimension (768)** — The embedding dimension is consistent. The cosine similarity implementation works with any dimension.
4. **In-memory only** — No persistence to disk. The buffer is lost on restart, which is fine since it's a rolling window of recent activity.

## What Gets Removed from `src/loop/states/tool.ts`

The following are **removed** from the lead agent's `tool.ts`:
- The `isRepetition` check (`sequence.getEvents().slice(-5).map(e => e.tool)`)
- The `READ_ONLY_BASH` regex (no longer needed for confusion scoring)
- The `ACTION_TOOLS` set (no longer needed for confusion scoring — check if used elsewhere in the file)

Note: `EXPLORATION_TOOLS` is **kept** — it determines whether to apply any confusion scoring at all (exploration tools don't affect confusion).

## Scope: Lead Agent Only

This change applies only to the **lead agent** (`src/loop/states/tool.ts`). The **teammate worker** (`src/context/teammate-worker.ts`) has its own copy of the same confusion scoring logic, but it doesn't have a hint round — it just mails the lead when confused. The teammate worker can be updated separately if needed.
