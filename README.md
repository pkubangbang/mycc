# mycc

A CLI coding agent using Ollama-cloud for LLM inference, written in nodejs.

> 2026-05-21: added Deepseek API support! You can use Deepseek in place of `ollama.chat` to leverage prompt cache
> (Ollama still need to be installed because of the embedding use)


## Features

- **tool use**: over 30 tools available for LLM, from basic `bash/read/write/edit`, to advance tools like `web_search`, `read_image`, and `wiki_put`(RAG).

- **team collaboration**: mycc starts with a single `lead`; teammates can be spawned by you or the `lead` to enable collaboration.

- **skill use**: describe the specialist knowledge using markdown, and LLM will learn it when needed.

- **mindmap**: compile your `CLAUDE.md` into a navigable knowledge tree; agents retrieve context on-demand via `get_node` tool for efficient knowledge navigation.

- **extensibility**: you can bring your own tools/skills into mycc, at project-level, or at the user-level that shared across projects.

- **session storage**: a new session is created at each start. You can `/load` a previous session to continue your work, or to expect variant responses thanks to LLM randomness.


## Installation

> **Notice:** mycc was initially developed on **Ubuntu 24.04**. You will have the best experience on the same platform. Other Linux distributions, macOS, and Windows may have minor compatibility issues.

### Prerequisites

This package includes native dependencies that require build tools:

- **Node.js** >= 18
- **Python** (for node-gyp)
- **C++ compiler** (GCC/Clang on Unix, Visual Studio Build Tools on Windows)

On Ubuntu/Debian:
```bash
sudo apt install build-essential python3
```

On macOS:
```bash
xcode-select --install
```

On Windows, install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/).

### Install from npm

```bash
npm install -g @pkubangbang/mycc
```

### Install from source

```bash
# Clone the repository
git clone https://github.com/pkubangbang/mycc.git
cd mycc

# Install dependencies
pnpm install

# Link globally (enables type imports for custom tools)
npm link
```

## Quick Start

### 1. Choose your LLM provider

mycc supports two LLM providers:

**Option A: Ollama (recommended)** — Run models locally. Enables all features including `web_search`, `web_fetch`, `screen`, and `read_picture`.

Install Ollama:
[download page of ollama](https://ollama.com/download)

Ollama cloud provides the max capability, however if you do not need the online tools,
and you are fine with the local LLM, Ollama alone without the cloud is also acceptable.

Recommended models: `glm-5:cloud` and `gemma4:31b-cloud`.

**Option B: DeepSeek** — Cloud-based API. Does not require local hardware. No `web_search`, `web_fetch`, `screen`, or `read_picture` support.

Get an API key at [platform.deepseek.com](https://platform.deepseek.com/api_keys) and set it as `DEEPSEEK_API_KEY`. An embedding model via Ollama is still needed for wiki/RAG features.

### 2. Install an embedding model (Required)

**An embedding model is required** for mycc to function properly. The embedding model is used for:
- Knowledge base (wiki) semantic search
- Skill matching and retrieval
- Document similarity operations

After installing Ollama, pull an embedding model:
```bash
ollama pull nomic-embed-text
```

Other embedding models like `mxbai-embed-large` or `all-minilm` also work. Make sure to update the `OLLAMA_EMBEDDING_MODEL` environment variable if you use a different model.

### 3. Install tmux (Required)

**tmux is required** for interactive terminal operations. mycc uses tmux for:
- Interactive programs (vim, htop, watch, etc.)
- SSH sessions to remote servers
- Commands requiring user input (prompts, passwords)
- Any task needing direct terminal access

Install tmux:

On Ubuntu/Debian:
```bash
sudo apt install tmux
```

On macOS:
```bash
brew install tmux
```

On Windows:
```bash
winget install psmux
```

`psmux` is a PowerShell-compatible alternative to tmux for Windows.

### 4. Run the setup wizard

Run the interactive setup wizard to configure your environment:

```bash
mycc --setup
```

The wizard will first ask you to choose an **API provider**:

**Option A: Ollama (default)** — Local LLM inference via Ollama.
The wizard will guide you through configuring:
- **OLLAMA_HOST** - Ollama server URL (default: http://127.0.0.1:11434)
- **OLLAMA_MODEL** - General/chat model (default: glm-5:cloud)
- **OLLAMA_VISION_MODEL** - Vision model for screen/image tools
- **OLLAMA_EMBEDDING_MODEL** - Embedding model for semantic search
- **OLLAMA_API_KEY** - API key for cloud features (optional)
- **TOKEN_THRESHOLD** - Context limit threshold (default: 50000)
- **EDITOR** - Text editor for file editing

**Option B: DeepSeek** — Cloud-based LLM via DeepSeek API.
The wizard will guide you through configuring:
- **DEEPSEEK_HOST** - DeepSeek API endpoint (default: https://api.deepseek.com)
- **DEEPSEEK_API_KEY** - Your DeepSeek API key (required)
- **DEEPSEEK_MODEL** - DeepSeek model name (default: deepseek-chat)
- **OLLAMA_EMBEDDING_MODEL** - Embedding model for semantic search (always uses Ollama)
- **TOKEN_THRESHOLD** - Context limit threshold (default: 50000)
- **EDITOR** - Text editor for file editing

> **Note:** When using DeepSeek, `web_search`, `web_fetch`, `screen`, and `read_picture` tools are **not available**. Embeddings for wiki/RAG still require Ollama (any embedding model).

You can choose to store configuration at:
- **User-level**: `~/.mycc-store/.env` (global, applies to all projects)
- **Project-level**: `./mycc/.env` (local, applies only to current project)

Note: The `OLLAMA_API_KEY` is only required if you use online tools (web_search, web_fetch). You can generate an API key at [ollama.com/settings/keys](https://ollama.com/settings/keys).

### 5. Start the app

Starting the app is as easy as a simple cmd:
```bash
mycc
```

Or if you need a faster startup, add a `--skip-healthcheck` flag:
```bash
mycc --skip-healthcheck
```

Or if you need more debug output, add a `-v` flag, or `--verbose`:
```bash
mycc -v
```

### Debug Flags

mycc provides several `--debug-*` flags for investigating specific subsystems:

| Flag | Effect |
|------|--------|
| `--debug-tp` | **Triologue Parity** — when a role transition violation occurs (e.g., `tool → user` without an `assistant` bridge), throw an error with a stack trace instead of auto-recovering. Useful when developing the auto-fixer or debugging `triologue.ts`. |
| `--debug-suggest` | **SUGGEST Background Task** — logs the LLM response and feedback of the background suggest task to the terminal via `ctx.core.brief()`. The SUGGEST task runs after each turn to proactively discover relevant tools/skills for the next user query. |
| `--debug-eval` | **Expression Evaluation** — prints the parsed AST tree for each hook condition expression during evaluation. Useful when developing hookish skills with custom `when` conditions in `evaluator.ts`. |

Combine with `-v` (verbose) for maximum detail:
```bash
mycc -v --debug-tp --debug-suggest
```

## Key Concepts

See the following documentation for detailed explanations:

- **Agent Loop**: `docs/agent-loop.md` - STAR principle, microCompact, autoCompact, todo nudging
- **Child Process Teammates**: `docs/child-context.md` - IPC, state machine, auto-claim
- **Dynamic Loading**: `docs/dynamic-loading.md` - Hot-reload, tool scopes, skill format
- **Mindmap**: `docs/mindmap-design.md` - Knowledge navigation, A-N-C-E summarization, process isolation
- **SQLite Persistence**: `docs/database-schema.md` - Tables, WAL mode, transactions

## Day-to-day Workflow as a user

1. open up the terminal and `cd` to the target folder
2. run `mycc` and wait for the `agent >> ` prompt to show
3. type something to instruct LLM to work for you
4. check the output and iterate
5. **If you find LLM go astray, hit ESC to interrupt (enter neglected mode), then wait for the prompt to show again to chat.**
6. Once finished work, hit ENTER at the prompt to exit, or use Ctrl + C anytime to quit the app.

## Day-to-day Workflow as mycc developer

1. open project files in vscode
2. start up the mycc using `pnpm start --skip-healthcheck`
3. instruct LLM to make code changes (*to itself!*)
4. instruct LLM to test the code using tmux
5. Debug by hit F5 (vscode debug mode)
6. Once the code is ready, run `npm link` to update the global `mycc` executive.

## License

MIT
