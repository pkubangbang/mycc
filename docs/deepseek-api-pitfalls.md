# DeepSeek API Pitfalls

Bugs encountered during the DeepSeek provider integration. Documented for reference.

## Testing Procedure

Test mycc with DeepSeek in a tmux session:

```bash
# 1. Create session and start mycc
tmux new-session -d -s mycc-test -x 120 -y 30
tmux send-keys -t mycc-test 'mycc' Enter

# 2. Wait for health check (~3s), then type query and wait 2s before Enter
#    (the 2s delay is required — the multiline editor needs time to process input)
sleep 5
tmux send-keys -t mycc-test 'hello world'
sleep 2
tmux send-keys -t mycc-test Enter

# 3. Wait for LLM response + tool execution, then capture output
sleep 15
tmux capture-pane -t mycc-test -p

# 4. Cleanup
tmux kill-session -t mycc-test
```

## Known Issues

### 1. `thinking: disabled` + `reasoning_effort` cannot coexist

**Symptom:** API returns 400 with `"thinking options type cannot be disabled when reasoning_effort is set"`.

**Cause:** When `think: false` (from Ollama's parameter), we set `thinking: { type: 'disabled' }` but left `reasoning_effort: 'high'` in the request body. DeepSeek rejects this combination.

**Fix:** When disabling thinking, also `delete body.reasoning_effort`.

**File:** `src/engine/deepseek.ts` — body construction in `retryChat`.

### 2. `tool_calls[].function.arguments` must be a JSON string, not an object

**Symptom:** API returns 400 with `"messages[N]: invalid type: map, expected a string"`.

**Cause:** Ollama's `ToolCall` type has `function.arguments` as a parsed `Record<string, unknown>` object. When we send it back to DeepSeek in subsequent messages, DeepSeek expects `function.arguments` to be a JSON string.

**Fix:** In `normalizeMessage()`, check `typeof tc.function.arguments` — if it's not a string, `JSON.stringify()` it.

**File:** `src/engine/deepseek.ts` — `normalizeMessage()`.

### 3. `tool_calls[].type` is required by DeepSeek but absent in Ollama

**Symptom:** API returns 400 with `"messages[N]: missing field 'type'"`.

**Cause:** DeepSeek requires `type: "function"` on each entry in the `tool_calls` array. Ollama's `ToolCall` type doesn't include a `type` field (the field exists at the API level but Ollama's TS types omit it).

**Fix:** In `normalizeMessage()`, add `type: tc.type || 'function'` to each tool call.

**File:** `src/engine/deepseek.ts` — `normalizeMessage()`.

### 4. `reasoning_content` must be echoed back in subsequent requests

**Symptom:** API returns 400 with `"The reasoning_content in the thinking mode must be passed back to the API"`.

**Cause:** DeepSeek requires that when an assistant message has `tool_calls`, its `reasoning_content` MUST be included in all subsequent requests (same turn and future turns). The triologue was not storing `reasoning_content` on assistant messages — only `content` and `tool_calls` were captured.

**Fix:**
- Added `assistantReasoningContent` to `PassData` (state-machine.ts)
- Extract `reasoning_content` from LLM response in `llm.ts` and `teammate-worker.ts`
- Added optional `reasoningContent` parameter to `triologue.agent()`
- `triologue.agent()` stores it in the message so `normalizeMessage()` can echo it back

**Files:** `src/loop/state-machine.ts`, `src/loop/states/llm.ts`, `src/loop/states/hook.ts`, `src/loop/triologue.ts`, `src/context/teammate-worker.ts`
