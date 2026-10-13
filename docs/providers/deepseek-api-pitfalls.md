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

### 5. Mode switch leaves assistant messages with tool_calls but no reasoning_content

**Symptom:** After `plan_on` tool switches from normal to plan mode, the next LLM call returns 400 with `"The reasoning_content in the thinking mode must be passed back to the API"`.

**Cause:** In normal mode, thinking is disabled (`think: false`), so assistant messages with tool_calls have no `reasoning_content`. When `plan_on` switches to plan mode, thinking is enabled. The pre-switch assistant messages (with tool_calls but no reasoning_content) are sent to DeepSeek, which requires reasoning_content on ALL assistant messages with tool_calls when thinking mode is active.

**Fix:** In `normalizeMessage()`, for assistant messages with tool_calls that lack reasoning_content, set it to empty string `""`. DeepSeek accepts this for messages generated without thinking mode.

**File:** `src/engine/deepseek.ts` — `normalizeMessage()`.

### 6. DSML tags leak into content stream (ASCII-pipe AND fullwidth-vline forms)

**Symptom:** DeepSeek sometimes emits internal markup tags directly into the text content stream. The pipe glyph around `DSML` may be an **ASCII vertical bar `|`** (U+007C — the real wire form), a **fullwidth vertical line** (U+FF5C), or a **mix** of the two on the two sides. Each side carries **one or two** pipes, giving these forms:
- ASCII-pipe double: two `|` per side (DeepSeek's actual output)
- fullwidth double: two U+FF5C per side (what the original matcher assumed)
- Single-pipe and mixed-asymmetric variants also occur.
- double-vline: `<｜｜DSML｜｜tagname>...</｜｜DSML｜｜tagname>` (two U+FF5C per side)
- single-vline: `<｜DSML｜tagname>...</｜DSML｜tagname>` (one U+FF5C per side)

Opening tags may also carry attributes, e.g. a DSML-wrapped `invoke name="brief"` opening tag.

**Cause:** DeepSeek's API occasionally injects DeepSeek Markup Language (DSML) tags (e.g. `tool_calls`, `safety`, `thinking`) into the `content` field of assistant messages. If not stripped, these raw tags appear in the user-facing display. The original fix gated `stripInternalMarkup()` on the fullwidth vline (U+FF5C) alone and assumed tags "use fullwidth vertical lines instead of ASCII pipes" — but DeepSeek's real output uses **ASCII pipes**, so the gate never fired for it and the raw markup leaked through on **both** display paths:
1. The letter-box (STOP state) — `includes(FW_VLINE)` was false for the ASCII form, so no regex ran.
2. Mid-loop `brief('info', 'assistant', chat.assistantContent)` calls in `hook.ts` (via `briefAssistantContent()`).

**Fix:** Two choke points, display-only (raw content stays in the triologue):
- `stripInternalMarkup()` matches the pipe as a per-side character class — ASCII `|` **or** fullwidth vline, `{1,2}` (single or double), on each side — and tolerates attributes on opening tags. The fast-path gate is now `includes('DSML')` (the invariant shared by every form), not `includes(FW_VLINE)`. Four pattern shapes are handled (paired, self-closing, opening-only, closing-only), for ASCII, fullwidth, and mixed forms alike.
- All mid-loop brief sites in `hook.ts` (checkpoint, recap, crossroad, normal path) route content through `briefAssistantContent()`, which strips DSML first and skips the brief if nothing displayable remains.

**Files:** `src/utils/letter-box.ts` — `stripInternalMarkup()`; `src/loop/states/hook.ts` — `briefAssistantContent()`. Tests in `src/tests/letter-box.test.ts` (ASCII-pipe, fullwidth, and mixed cases).
