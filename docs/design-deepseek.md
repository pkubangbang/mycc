# DeepSeek Provider Integration — Design Spec & Setup Update Plan

## 1. Overview

mycc now supports two LLM providers: **Ollama** (the original) and **DeepSeek** (new). The provider is selected at runtime via the `API_PROVIDER` environment variable (`"ollama"` or `"deepseek"`). The architecture uses a **facade pattern** (`src/engine/chat-provider.ts`) that re-exports from the active provider module, enabling the rest of the codebase to remain provider-agnostic.

## 2. Architecture

```
mycc --setup
  ├── prompts.ts          # Defines which env vars to ask about
  ├── wizard.ts           # Interactive readline prompts
  ├── models.ts           # Ollama model pulling (not applicable to DeepSeek)
  ├── display.ts          # Current settings display
  └── index.ts            # Orchestrator

CLI startup (index.ts / lead.ts)
  ├── config.ts           # getApiProvider(), getDeepSeek*(), getOllama*()
  ├── loadEnv()           # ~/.mycc-store/.env + ./.mycc/.env
  └── agent-repl.ts
       └── healthCheck()  # Dispatched via chat-provider.ts → deepseek.ts

Engine
  ├── chat-provider.ts    # FACADE: re-exports from active provider
  ├── chat-helpers.ts     # SHARED: retry logic, stream collection, spinner
  ├── deepseek.ts         # DeepSeek-specific: fetch() + SSE, message normalization
  └── ollama.ts           # Ollama-specific: Ollama SDK client
```

## 3. What Already Exists (Code Complete)

### 3.1 Provider Implementation (`src/engine/deepseek.ts`)

- **`retryChat()`** — DeepSeek API calls via raw `fetch()` with SSE streaming, retry logic, spinner support, and timeout handling
- **`retryMultipleChoice()`** — Multiple choice extraction (same pattern as ollama.ts)
- **`healthCheck()`** — Connectivity + model probe using `start_up` tool
- **`structuredChat()`** — Non-streaming chat with JSON response format
- **Stubs** for `webSearch()`, `webFetch()`, `imgDescribe()` — throw "not supported" errors
- **Message normalization** (`normalizeMessage()`) — Converts Ollama-format messages to DeepSeek format, handles:
  - `thinking` → `reasoning_content` conversion
  - `tool_calls[].function.arguments` string serialization
  - `tool_calls[].type` injection (required by DeepSeek, absent in Ollama types)
  - `reasoning_content` echoing for pre-switch assistant messages (empty string fallback)

### 3.2 Provider Facade (`src/engine/chat-provider.ts`)

- Statically imports both `./ollama.js` and `./deepseek.js`
- Uses `getApiProvider()` from config.ts to select active module
- Re-exports: `MODEL`, `retryChat`, `retryMultipleChoice`, `webSearch`, `webFetch`, `imgDescribe`, `structuredChat`, `healthCheck`
- Embedding always uses Ollama (`./ollama-embedding.js`)
- Agnostic utilities re-exported from `./chat-helpers.js`

### 3.3 Config Functions (`src/config.ts`)

| Function | Description |
|----------|-------------|
| `getApiProvider()` | Returns `'ollama'` or `'deepseek'` based on `API_PROVIDER` env var |
| `getDeepSeekHost()` | Returns `DEEPSEEK_HOST` or default `'https://api.deepseek.com'` |
| `getDeepSeekApiKey()` | Returns `DEEPSEEK_API_KEY` |
| `getDeepSeekModel()` | Returns `DEEPSEEK_MODEL` or default `'deepseek-v4-pro'` |
| `getOllamaModel()` | Returns `OLLAMA_MODEL` or default `'glm-5:cloud'` |

### 3.4 Reasoning Content Flow

DeepSeek requires `reasoning_content` to be echoed back on all subsequent assistant messages with `tool_calls` when thinking mode is active. The following changes support this:

- **`src/types.ts`**: `Message` interface now has optional `reasoning_content?: string`
- **`src/loop/state-machine.ts`**: `PassData` has `assistantReasoningContent?: string`
- **`src/loop/states/llm.ts`**: Extracts `reasoning_content` from LLM response, stores on `pass`
- **`src/loop/states/hook.ts`**: Passes `pass.assistantReasoningContent` to `triologue.agent()`
- **`src/loop/triologue.ts`**: `agent()` accepts optional `reasoningContent` param, stores in message
- **`src/engine/deepseek.ts`**: `normalizeMessage()` echoes `reasoning_content` from stored messages
- **`src/context/teammate-worker.ts`**: Extracts `reasoning_content` for child process agents

### 3.5 Known Pitfalls Documented

`docs/deepseek-api-pitfalls.md` documents 5 issues encountered and their fixes:

1. `thinking: disabled` + `reasoning_effort` cannot coexist → delete `reasoning_effort` when disabled
2. `tool_calls[].function.arguments` must be string, not object → `JSON.stringify()`
3. `tool_calls[].type` required by DeepSeek → inject `type: 'function'`
4. `reasoning_content` must be echoed in subsequent requests → store and echo
5. Mode switch leaves message with tool_calls but no `reasoning_content` → set empty string

## 4. Setup Process — DeepSeek Support (Shipped)

The setup wizard (`mycc --setup`) now supports both Ollama and DeepSeek providers. The provider selection is the first step in the wizard flow, and subsequent prompts adapt based on the choice.

### 4.1 What Shipped

#### A. `src/setup/prompts.ts` — Provider selection + conditional prompts

- `getPrompts(provider)` accepts `'ollama' | 'deepseek'` and returns the appropriate prompt set
- `getOllamaConnectionPrompts()` — common prompts (OLLAMA_HOST, OLLAMA_EMBEDDING_MODEL) always asked (embeddings always use Ollama)
- `getOllamaPrompts()` — Ollama-specific: OLLAMA_API_KEY, OLLAMA_MODEL, OLLAMA_VISION_MODEL
- `getDeepSeekPrompts()` — DeepSeek-specific: DEEPSEEK_HOST (default `https://api.deepseek.com`), DEEPSEEK_API_KEY (sensitive), DEEPSEEK_MODEL (default `deepseek-chat`)
- `getSharedPrompts()` — TOKEN_THRESHOLD, EDITOR (always asked)
- `ENV_REQUIREMENTS` includes all DeepSeek vars + `API_PROVIDER`

#### B. `src/setup/wizard.ts` — Provider choice + conditional branching

- `promptProviderChoice()` — choice prompt (1=Ollama, 2=DeepSeek), returns `'ollama' | 'deepseek'`
- `runWizard()` branches on provider choice, calls `getPrompts(provider)` for the appropriate prompts
- `displaySetupHelp()` shows both Ollama and DeepSeek env vars
- Always prompts for OLLAMA_HOST and OLLAMA_EMBEDDING_MODEL (embeddings require local Ollama even with DeepSeek)

#### C. `src/setup/models.ts` — Skip pulling for DeepSeek

- `pullConfiguredModels(provider?)` accepts optional provider parameter
- When provider is `'deepseek'`, skips `ollama pull` entirely and shows informational message about cloud-based models
- When provider is Ollama (or undefined), keeps existing pull logic

#### D. `src/setup/display.ts` — DeepSeek settings in display

- `DEEPSEEK_API_KEY` marked as sensitive (redacted like `OLLAMA_API_KEY`)
- DeepSeek vars included in `ENV_REQUIREMENTS` so they show in `displayCurrentSettings()`

#### E. `src/setup/index.ts` — Orchestrator

- Reads `API_PROVIDER` from config, passes provider to `pullConfiguredModels()`
- Success message reflects the selected provider

#### F. `README.md` — DeepSeek documentation

- Documents `API_PROVIDER` env var and DeepSeek as alternative provider
- Notes that `web_search` is supported (server-side via the DeepSeek Responses API), but `web_fetch`, `screen`, and `read_picture` are not supported with DeepSeek

#### G. `src/loop/agent-repl.ts` — Startup display

- Shows `API_PROVIDER` in startup info
- Shows provider-specific host info

## 5. Implementation Status

All items in the original implementation plan have been shipped. The changes are described in §4 above. See the following source files for the current implementation:

| File | Status |
|------|--------|
| `src/setup/prompts.ts` | ✅ Provider choice + conditional prompts + ENV_REQUIREMENTS |
| `src/setup/wizard.ts` | ✅ Provider choice logic + conditional branching |
| `src/setup/display.ts` | ✅ DeepSeek vars in display/redaction |
| `src/setup/models.ts` | ✅ Provider param, skip pulling for DeepSeek |
| `src/setup/index.ts` | ✅ Pass provider info, provider-aware success message |
| `src/loop/agent-repl.ts` | ✅ Show provider in startup banner |
| `README.md` | ✅ Document DeepSeek as alternative provider |

## 7. Assumptions & Dependencies

- **No new npm packages needed** — DeepSeek calls use native `fetch()` (available in Node.js 18+)
- **DeepSeek API key is required** — User must have a DeepSeek account
- **Embedding still uses Ollama** — Even when DeepSeek is the LLM provider, embeddings go through `ollama-embedding.ts`. The setup wizard should still prompt for `OLLAMA_EMBEDDING_MODEL` even when DeepSeek is selected.
- **No tests for DeepSeek yet** — The unit tests don't cover the deepseek provider; this is out of scope for the current plan
- **No vision/web tools for DeepSeek** — `screen`, `read_picture`, `web_search`, `web_fetch` tools will fail with an informative error when using DeepSeek provider. This is documented behavior.
