# mycc

A CLI coding agent using Ollama-cloud for LLM inference, written in nodejs.


## Features

- **tool use**: over 30 tools available for LLM, from basic `bash/read/write/edit`, to advance tools like `web_search`, `read_image`, and `wiki_put`(RAG).

- **team collaboration**: mycc starts with a single `lead`; teammates can be spawned by you or the `lead` to enable collaboration.

- **skill use**: describe the specialist knowledge using markdown, and LLM will learn it when needed.

- **extensibility**: you can bring your own tools/skills into mycc, at project-level, or at the user-level that shared across projects.

- **session storage**: a new session is created at each start. You can `/load` a previous session to continue your work, or to expect variant responses thanks to LLM randomness.


## Installation

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

# Build and link
pnpm build
npm link
```

## Quick Start

### 1. Install Ollama and enable Ollama Cloud

`mycc` relies on `ollama cloud` to work normally. So **ollama** must be installed beforehand. 

[download page of ollama](https://ollama.com/download)

Ollama cloud provides the max capability, however if you do not need the online tools (web_search/web_fetch/screen/read_image),
and you are fine with the local LLM, the `ollama ` alone without the cloud is also acceptable.

As the choice of LLM model, `glm-5:cloud` and `gemma4:31b-cloud` are recommended.

### 2. Config the environment variables
Create a file at `~/.mycc-store/.env` with variables like below.

You can also view the content from the `.env.example` file.

```ini
# Ollama configuration
# For local Ollama: http://127.0.0.1:11434
# For Ollama cloud: https://api.ollama.com
OLLAMA_HOST=http://127.0.0.1:11434
OLLAMA_MODEL=glm-5:cloud

# API key for cloud models and web search/fetch (required for web_search and web_fetch tools)
OLLAMA_API_KEY=your_api_key_here

# Token threshold for context compaction (default: 50000)
TOKEN_THRESHOLD=50000

# Editor for opening files (falls back to VISUAL or EDITOR env vars)
EDITOR=xdg-open
```

Note: the `OLLAMA_API_KEY` is only required if you use the online tools; otherwise leave it blank.
You can generate an api key [at here (need login)](https://ollama.com/settings/keys)

### 3. Start the app

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

## Key Concepts

See the following documentation for detailed explanations:

- **Agent Loop**: `docs/agent-loop.md` - STAR principle, microCompact, autoCompact, todo nudging
- **Child Process Teammates**: `docs/child-context.md` - IPC, state machine, auto-claim
- **Dynamic Loading**: `docs/dynamic-loading.md` - Hot-reload, tool scopes, skill format
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
6. Once the code is ready, run `pnpm build && npm link` to update the global `mycc` executive.

## License

MIT