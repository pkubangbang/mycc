# mycc

A CLI coding agent using Ollama-cloud for LLM inference, written in nodejs.

> 2026-05-21: added Deepseek API support! You can use Deepseek in place of `ollama.chat` to leverage prompt cache
> (Ollama still need to be installed because of the embedding use)


## Features

- **tool use**: over 30 tools available for LLM, from basic `bash/read/write/edit`, to advance tools like `web_search`, `read_image`, and `wiki_put`(RAG).

- **team collaboration**: mycc starts with a single `lead`; teammates can be spawned by you or the `lead` to enable collaboration.

- **cross-machine peers**: connect mycc instances running on **different machines** over a peer wire so they can exchange mail via the same `mail_to` interface used for same-machine peers. Use `peer_connect` to add a remote instance by its serve URL, `peer_list` to see all reachable peers (local and remote) with a liveness indicator, and `peer_disconnect` to hang up. See [Cross-machine peer wire](#cross-machine-peer-wire) below.

- **skill use**: describe the specialist knowledge using markdown, and LLM will learn it when needed.

- **mindmap**: compile your `MYCC.md` into a navigable knowledge tree; agents retrieve context on-demand via `get_node` tool for efficient knowledge navigation.

- **extensibility**: you can bring your own tools/skills into mycc, at project-level, or at the user-level that shared across projects.

- **session storage**: a new session is created at each start. Sessions are **sealed** once the process exits — they become read-only archives and are never written to again. `/load <id>` (or `mycc --from <id>`) derives a **brand new** session from the old one: the LLM re-understands the old transcript and generates a fresh starting context. Loading the same id multiple times yields different new sessions (variation by re-understanding) — use this to branch and explore alternatives.


## Installation

> **Notice:** mycc was initially developed on **Ubuntu 24.04**. You will have the best experience on the same platform. Other Linux distributions, macOS, and Windows may have minor compatibility issues.

### Prerequisites

- **Node.js** >= 18

The native dependencies (`sharp`, `@lancedb/lancedb`, `ripgrep`) ship **prebuilt binaries** (or WASM) for common platforms, so a **C++ compiler is not always required**. You only need build tools (GCC/Clang on Unix, Visual Studio Build Tools on Windows) when installing on a platform without a prebuilt binary, or when building from source.

On Ubuntu/Debian (only if you need to build from source):
```bash
sudo apt install build-essential python3
```

On macOS (only if you need to build from source):
```bash
xcode-select --install
```

On Windows (only if you need to build from source), install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/).

### Install from source

> **Note:** `@pkubangbang/mycc` is **not published** to the npm registry, so there is no `npm install -g` path. You must run mycc from source.

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

**Option B: DeepSeek** — Cloud-based API. Does not require local hardware. Supports `web_search` (server-side via the Responses API — the search runs on DeepSeek's servers and returns a synthesized answer). `web_fetch`, `screen`, and `read_picture` are **not** supported.

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

### 3. Install tmux (Optional)

**tmux is optional** — it is only used by the `hand_over` tool for interactive terminal operations (e.g. entering a password, an interactive TUI like vim/htop, or an SSH session). It does **not** block the main agent loop: the core tools (`bash`, `read`, `write`, `edit`, etc.) run without tmux. Install it only if you need the `hand_over` tool.

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

> **Note:** When using DeepSeek, `web_search` **is** available (server-side via the Responses API), but `web_fetch`, `screen`, and `read_picture` tools are **not available**. Embeddings for wiki/RAG still require Ollama (any embedding model).

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

#### Auto mode

Run mycc **autonomously** without a human at the terminal. The lead loop runs on its own (no `agent >> ` prompt); press ESC to exit auto mode and return to the prompt.

```bash
mycc --auto
```

#### Daemon mode

Run mycc as a **detached, headless background process** (auto mode is forced on, no terminal). Optionally pass a skill name to auto-load it and start its cron timer (if the skill declares `service_cron`):

```bash
mycc --daemon            # passive daemon, waits for external mail
mycc --daemon <skill>    # daemon that auto-loads a service skill and starts its cron
```

### 6. Cross-machine peer wire (Optional)

mycc instances on **different machines** can be wired together so they exchange mail exactly like same-machine peers — `mail_to(name="<sessionId>/lead", ...)` works unchanged whether the peer is local or remote. The remote plane is a single dialed WebSocket per peer pair (one outbound connection gives a bidirectional pipe, so a NAT'd/firewalled instance can dial out even with no inbound port).

**Setup:**

1. On the **remote** machine, start mycc with its web UI serving (so it can accept a wire):
   ```bash
   mycc --serve 3191            # or: mycc --daemon (persistent, headless)
   ```
2. On the **local** machine, add the remote by its serve URL:
   ```bash
   # inside the mycc prompt, or instruct the LLM:
   peer_connect 192.168.1.20:3191
   ```
3. Discover reachable peers (both same-machine and remote) with `peer_list`; send mail to any of them with `mail_to(name="<sessionId>/lead", ...)`; hang up a remote with `peer_disconnect`.

**The `MYCC_WIRE_TOKEN` environment variable (optional):**

`MYCC_WIRE_TOKEN` is an **optional** shared secret that gates the `/peer/ws` upgrade endpoint when configured.

- **Unset on both instances (default)** — the wire endpoint is **open**: any peer that can reach the serving port may connect. Security is the **operator's responsibility at OSI L3** — bind the serve port to a private interface, put it behind a firewall, front it with a TLS reverse proxy, or restrict it to a VPN / SSH tunnel. mycc intentionally does not impose an in-app auth gate by default.
- **Set to the same value on both instances** — the dialer sends the token as a query parameter on the WS upgrade, and the acceptor refuses any upgrade whose token is missing or mismatched (HTTP 401). Use this if you want an in-app auth layer in addition to (or instead of) network-layer controls.

> **Note:** `MYCC_WIRE_TOKEN` is **not** part of the `--setup` wizard (it is an advanced/optional knob). Set it directly in your environment or `.env` file (`~/.mycc-store/.env` user-level or `./mycc/.env` project-level) on **both** instances if you want the gate, or pass it as a CLI flag (`--wire-token <value>`) on either instance.

> **See also:** [`docs/remote-peer-protocol.md`](docs/remote-peer-protocol.md) — the full design: dialer/acceptor roles, connect/disconnect workflow, pair-dedupe invariant, convergence, mail routing, liveness.

### Configuration Flags

All environment variables can be overridden via CLI flags. These take highest priority, overriding `.env` files and system environment variables.

| Flag | Env Variable | Description |
|------|-------------|-------------|
| `--ollama-host` | `OLLAMA_HOST` | Ollama server URL (default: http://127.0.0.1:11434) |
| `--ollama-api-key` | `OLLAMA_API_KEY` | Ollama API key for cloud features |
| `--ollama-model` | `OLLAMA_MODEL` | Ollama chat model (default: glm-5:cloud) |
| `--ollama-vision-model` | `OLLAMA_VISION_MODEL` | Ollama vision model for screen/image tools |
| `--ollama-embedding-model` | `OLLAMA_EMBEDDING_MODEL` | Embedding model for semantic search/RAG |
| `--deepseek-host` | `DEEPSEEK_HOST` | DeepSeek API endpoint (default: https://api.deepseek.com) |
| `--deepseek-api-key` | `DEEPSEEK_API_KEY` | DeepSeek API key |
| `--deepseek-model` | `DEEPSEEK_MODEL` | DeepSeek model name (default: deepseek-chat) |
| `--api-provider` | `API_PROVIDER` | API provider: "ollama" or "deepseek" (default: ollama) |
| `--token-threshold` | `TOKEN_THRESHOLD` | Context limit threshold (default: 50000) |
| `--editor` | `EDITOR` | Text editor for file editing |
| `--skill-match-threshold` | `SKILL_MATCH_THRESHOLD` | Skill similarity threshold 0-1 (default: 0.5) |
| `--max-upload-mb` | `MYCC_MAX_UPLOAD_MB` | Max single-file upload size (MB) for the `/serve` Web UI (default: 50) |
| `--auto` | — | Start in autonomous mode (no user prompts) |
| `--daemon [skill]` | — | Detached headless daemon (forces auto mode); optionally auto-load a service skill and start its cron |
| `--allow-plan-off` | `MYCC_ALLOW_PLAN_OFF` | In auto mode, auto-approve `plan_off` to exit plan mode without confirmation |
| `--wire-token` | `MYCC_WIRE_TOKEN` | Optional shared secret for the `/peer/ws` peer-wire upgrade (set the same value on both instances to enable the in-app auth gate; unset on both to run the wire open — see [Cross-machine peer wire](#cross-machine-peer-wire)) |
| `--debug-wire` | `MYCC_WIRE_ALLOW_LOCAL` | Test-only escape hatch: allow `peer_connect` to a same-store / self peer (same-machine smoke test). Not for production. |

Example usage:
```bash
mycc --ollama-model gemma4:31b-cloud --token-threshold 80000
```

#### Understanding `--token-threshold` / `TOKEN_THRESHOLD`

`TOKEN_THRESHOLD` is the **context budget** mycc manages for the conversation history (system prompt + project context + all user/assistant/tool messages). It is **not** the model's maximum context window — it is a soft limit mycc enforces *below* that window via **auto-compaction**.

- As the conversation grows, mycc estimates the running token count. When it exceeds `TOKEN_THRESHOLD`, an **auto-compact** runs: the history is summarized (preserving accomplishments, current state, key decisions, and recent working memory) and replaced with a short summary pair, freeing the budget for new turns.
- This keeps the agent's attention on the active task instead of letting stale, verbose tool results accumulate until the model truncates or errors out.

**Why it must be less than the model's max context:**

The model's maximum context (e.g. 128k for `glm-5:cloud`, 131k for `deepseek-chat`) is the hard ceiling the provider enforces — requests beyond it are rejected or silently truncated. `TOKEN_THRESHOLD` should sit comfortably *below* that ceiling because:

1. **Headroom for the current turn** — the threshold is checked *before* the next LLM call. The agent's reply (which can be long, including tool-call definitions and reasoning) plus any tool results generated this turn are appended *after* the check, so they need to fit inside the remaining gap between `TOKEN_THRESHOLD` and the model's max context.
2. **Headroom for tools and overhead** — the full tool schema (30+ tool definitions), system prompt, and project context (README, mindmap instructions) are sent on every call and consume tokens not fully captured by the running estimate. Leaving a buffer prevents edge-case overflow.
3. **Avoid provider-side truncation** — if `TOKEN_THRESHOLD` were set at or above the model's max context, auto-compact would never trigger in time, and the provider would reject the oversized request (a hard failure) rather than mycc summarizing gracefully (a soft recovery).

**Rule of thumb:** set `TOKEN_THRESHOLD` to roughly **70–80% of the model's max context**. For example, with a 128k-context model, `--token-threshold 80000`–`100000` leaves ample headroom for the current turn, tool schemas, and overhead while still maximizing the usable history before compaction kicks in.

> **See also:** [`docs/compact-working-memory.md`](docs/compact-working-memory.md) — details the auto-compact mechanism, the LLM-stage compaction, and the working-memory focus extraction that preserves recent focus across compaction.

### Debug Flags

mycc provides several `--debug-*` flags for investigating specific subsystems:

| Flag | Effect |
|------|--------|
| `--debug-tp` | **Triologue Parity** — when a role transition violation occurs (e.g., `tool → user` without an `assistant` bridge), throw an error with a stack trace instead of auto-recovering. Useful when developing the auto-fixer or debugging `triologue.ts`. |
| `--debug-suggest` | **SUGGEST Background Task** — logs the LLM response and feedback of the background suggest task to the terminal via `ctx.core.brief()`. The SUGGEST task runs after each turn to proactively discover relevant tools/skills for the next user query. |
| `--debug-eval` | **Expression Evaluation** — prints the parsed AST tree for each hook condition expression during evaluation. Useful when developing hookish skills with custom `when` conditions in `evaluator.ts`. |
| `--disable-crossroad` | **Skip Crossroad** — disables turning-word detection entirely. No truncation, no continuation generation. Use when crossroad fires false positives (e.g. when the LLM's output legitimately mentions a word matching a turning pattern, such as a state name). |

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
- **Remote Peer Wire**: `docs/remote-peer-protocol.md` - Cross-machine peer connections, dialer/acceptor, pair-dedupe, optional wire token

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

> Note: this repo should enable the skill manager.

## License

MIT
