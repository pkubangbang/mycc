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

## 4. What Needs to Change — Setup Process

### 4.1 Problem

The setup wizard (`mycc --setup`) is **Ollama-only**. It has no awareness of DeepSeek as an alternative provider:

- **`src/setup/prompts.ts`**: `getPrompts()` and `ENV_REQUIREMENTS` only define Ollama variables
- **`src/setup/wizard.ts`**: `displaySetupHelp()` only shows Ollama env vars
- **`src/setup/models.ts`**: `pullConfiguredModels()` only runs `ollama pull`
- **`src/setup/display.ts`**: Uses `ENV_REQUIREMENTS` which lacks DeepSeek vars
- **`README.md`**: No mention of DeepSeek as an alternative

### 4.2 Required Changes

#### A. `src/setup/prompts.ts` — Add DeepSeek vars + provider selection

- Add `API_PROVIDER` to `getPrompts()` as a **choice prompt** (1=Ollama, 2=DeepSeek)
- Add conditional prompts: when DeepSeek selected, ask for `DEEPSEEK_HOST`, `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL`
- When Ollama selected, ask the existing Ollama vars
- Update `ENV_REQUIREMENTS` to include DeepSeek vars

**Design Decision**: The provider selection should be **first** in the wizard flow. Based on the choice, subsequent prompts adapt.

#### B. `src/setup/wizard.ts` — Conditional prompting

- `displaySetupHelp()` should show both Ollama and DeepSeek options
- `runWizard()` should branch on provider choice
- Add a `promptChoice()` helper for the provider selection

#### C. `src/setup/models.ts` — Skip pulling for DeepSeek

- When provider is DeepSeek, skip `ollama pull` entirely
- Show informational message: "DeepSeek models are cloud-based; no local pull needed"
- When provider is Ollama, keep existing pull logic

#### D. `src/setup/display.ts` — Show DeepSeek settings

- Include DeepSeek vars in `ENV_REQUIREMENTS` so they show in `displayCurrentSettings()`
- Mark `DEEPSEEK_API_KEY` as sensitive (like `OLLAMA_API_KEY`)

#### E. `src/setup/index.ts` — Orchestrator update

- Pass provider choice through to `pullConfiguredModels()` so it can skip
- Ensure the wizard flow feels natural with the branching

#### F. `README.md` — Document DeepSeek provider

- Add a "DeepSeek as LLM Provider" section under Quick Start
- Explain the `API_PROVIDER` env var
- List required env vars for DeepSeek
- Note that `web_search`, `web_fetch`, and `screen/read_picture` are not supported by DeepSeek

#### G. `src/loop/agent-repl.ts` — Startup display

- Show `API_PROVIDER` in startup info
- Show provider-specific host info (DeepSeek host or Ollama host)

## 5. Implementation Plan

### Step 1: Update `src/setup/prompts.ts`

- Add `API_PROVIDER` prompting (choice-based)
- Define `getOllamaPrompts()` and `getDeepSeekPrompts()` groupings
- Update `ENV_REQUIREMENTS` with DeepSeek entries

### Step 2: Update `src/setup/wizard.ts`

- Add provider choice prompt first
- Branch to Ollama-specific or DeepSeek-specific prompts
- Update `displaySetupHelp()` with both providers

### Step 3: Update `src/setup/display.ts`

- Add DeepSeek vars to display
- Handle provider-conditional display (hide Ollama vars when DeepSeek is active, or show all)

### Step 4: Update `src/setup/models.ts`

- Accept provider parameter
- Skip `ollama pull` when provider is DeepSeek
- Show informational message for DeepSeek

### Step 5: Update `src/setup/index.ts`

- Pass provider info through to models stage
- Update success message to reflect provider

### Step 6: Update `README.md`

- Add DeepSeek documentation section
- Update configuration table

### Step 7: Update `src/loop/agent-repl.ts`

- Show `API_PROVIDER` in startup banner
- Show appropriate host URL

## 6. Files to Change

| File | Change Scope |
|------|-------------|
| `src/setup/prompts.ts` | Add provider choice + conditional prompts + ENV_REQUIREMENTS update |
| `src/setup/wizard.ts` | Add provider choice logic + conditional branching |
| `src/setup/display.ts` | Add DeepSeek vars to display/redaction |
| `src/setup/models.ts` | Accept provider param, skip pulling for DeepSeek |
| `src/setup/index.ts` | Pass provider info, update success messages |
| `src/loop/agent-repl.ts` | Show provider in startup banner |
| `README.md` | Document DeepSeek as alternative provider |

## 7. Assumptions & Dependencies

- **No new npm packages needed** — DeepSeek calls use native `fetch()` (available in Node.js 18+)
- **DeepSeek API key is required** — User must have a DeepSeek account
- **Embedding still uses Ollama** — Even when DeepSeek is the LLM provider, embeddings go through `ollama-embedding.ts`. The setup wizard should still prompt for `OLLAMA_EMBEDDING_MODEL` even when DeepSeek is selected.
- **No tests for DeepSeek yet** — The unit tests don't cover the deepseek provider; this is out of scope for the current plan
- **No vision/web tools for DeepSeek** — `screen`, `read_picture`, `web_search`, `web_fetch` tools will fail with an informative error when using DeepSeek provider. This is documented behavior.
