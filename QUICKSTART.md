# mycc Quick Start

> This is the getting-started guide for **mycc** — install it, choose an LLM
> provider, and run your first session. For an overview of what mycc is and
> its features, see [README.md](README.md).

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

**Option B: DeepSeek** — Cloud-based API. Does not require local hardware. Supports `web_search` (server-side via the Responses API — the search runs on DeepSeek's servers and returns a synthesized answer) and `screen`/`read_picture` image understanding (via the `deepseek-flash` vision model). `web_fetch` is **not** supported.

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
- **DEEPSEEK_MODEL** - DeepSeek model name (default: deepseek-v4-pro)
- **DEEPSEEK_VISION_MODEL** - DeepSeek vision model for screen/image tools (default: deepseek-flash)
- **OLLAMA_EMBEDDING_MODEL** - Embedding model for semantic search (always uses Ollama)
- **TOKEN_THRESHOLD** - Context limit threshold (default: 50000)
- **EDITOR** - Text editor for file editing

> **Note:** When using DeepSeek, `web_search` **is** available (server-side via the Responses API) and `screen`/`read_picture` image understanding **is** available via the `deepseek-flash` vision model (set `DEEPSEEK_VISION_MODEL`, default `deepseek-flash`; set it to `none` to disable). `web_fetch` is **not available**. Embeddings for wiki/RAG still require Ollama (any embedding model).

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
- **Set to the same value on both instances** — the dialer sends the token as the `X-MYCC-Wire-Token` request header on the WS upgrade, and the acceptor refuses any upgrade whose token is missing or mismatched (HTTP 401). Use this if you want an in-app auth layer in addition to (or instead of) network-layer controls. (The token travels as a request header rather than a `?token=` query string so it does not leak into reverse-proxy access logs, HTTP debugging middleware, or request-URL diagnostics.)

> **Note:** `MYCC_WIRE_TOKEN` is **not** part of the `--setup` wizard (it is an advanced/optional knob). Set it directly in your environment or `.env` file (`~/.mycc-store/.env` user-level or `./mycc/.env` project-level) on **both** instances if you want the gate, or pass it as a CLI flag (`--wire-token <value>`) on either instance.

> **See also:** [`docs/peers/remote-peer-protocol.md`](docs/peers/remote-peer-protocol.md) — the full design: dialer/acceptor roles, connect/disconnect workflow, pair-dedupe invariant, convergence, mail routing, liveness.
