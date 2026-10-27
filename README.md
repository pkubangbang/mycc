# MYCC - My Coding Company

A CLI coding agent using Ollama-cloud for LLM inference, written in nodejs.

**Getting started:** see [QUICKSTART.md](QUICKSTART.md) for installation,
provider setup (Ollama / DeepSeek), the embedding model, tmux, the setup
wizard, launching the app (auto / daemon / serve), and the optional
cross-machine peer wire.

> New to mycc's concepts (letterbox, session, teammate, mindmap, intent
> language)? The `mycc-self-awareness` skill is a plain-language glossary.


## Features

- **tool use**: over 30 tools available for LLM, from basic `bash/read/write/edit`, to advance tools like `web_search`, `read_image`, and `wiki_put`(RAG).

- **team collaboration**: mycc starts with a single `lead`; teammates can be spawned by you or the `lead` to enable collaboration.

- **cross-machine peers**: connect mycc instances running on **different machines** over a peer wire so they can exchange mail via the same `mail_to` interface used for same-machine peers. Use `peer_connect` to add a remote instance by its serve URL, `peer_list` to see all reachable peers (local and remote) with a liveness indicator, and `peer_disconnect` to hang up. See [Cross-machine peer wire](QUICKSTART.md#6-cross-machine-peer-wire-optional) in QUICKSTART.md.

- **skill use**: describe the specialist knowledge using markdown, and LLM will learn it when needed.

- **mindmap**: compile your `MYCC.md` into a navigable knowledge tree; agents retrieve context on-demand via `get_node` tool for efficient knowledge navigation.

- **extensibility**: you can bring your own tools/skills into mycc, at project-level, or at the user-level that shared across projects.

- **session storage**: a new session is created at each start. Sessions are **sealed** once the process exits — they become read-only archives and are never written to again. `/load <id>` (or `mycc --from <id>`) derives a **brand new** session from the old one: the LLM re-understands the old transcript and generates a fresh starting context. Loading the same id multiple times yields different new sessions (variation by re-understanding) — use this to branch and explore alternatives.


## Configuration Flags

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
| `--deepseek-model` | `DEEPSEEK_MODEL` | DeepSeek model name (default: deepseek-v4-pro) |
| `--deepseek-vision-model` | `DEEPSEEK_VISION_MODEL` | DeepSeek vision model for screen/image tools (default: deepseek-flash) |
| `--api-provider` | `API_PROVIDER` | API provider: "ollama" or "deepseek" (default: ollama) |
| `--token-threshold` | `TOKEN_THRESHOLD` | Context limit threshold (default: 50000) |
| `--editor` | `EDITOR` | Text editor for file editing |
| `--skill-match-threshold` | `SKILL_MATCH_THRESHOLD` | Skill similarity threshold 0-1 (default: 0.5) |
| `--max-upload-mb` | `MYCC_MAX_UPLOAD_MB` | Max single-file upload size (MB) for the `/serve` Web UI (default: 50) |
| `--auto` | — | Start in autonomous mode (no user prompts) |
| `--daemon [skill]` | — | Detached headless daemon (forces auto mode); optionally auto-load a service skill and start its cron |
| `--allow-plan-off` | `MYCC_ALLOW_PLAN_OFF` | In auto mode, auto-approve `plan_off` to exit plan mode without confirmation |
| `--allow-auto-commit <branches>` | `MYCC_ALLOW_AUTO_COMMIT` | SEED for the live auto-commit branch allow-list (exact names, no globs). Seeded branches also bypass the commit prompt outside auto mode. Edit the live list at runtime with `/auto-commit on <b>` / `off <b>` / `off --all`; `/reload` re-seeds from this flag (the original value), so session edits are discarded. Auto-approved commits carry an `Auto-Committed-By` trailer. Pair with CI on protected branches — the flag is a narrow operator grant, not a security boundary |
| `--wire-token` | `MYCC_WIRE_TOKEN` | Optional shared secret for the `/peer/ws` peer-wire upgrade (set the same value on both instances to enable the in-app auth gate; unset on both to run the wire open — see [Cross-machine peer wire](QUICKSTART.md#6-cross-machine-peer-wire-optional) in QUICKSTART.md) |

Example usage:
```bash
mycc --ollama-model gemma4:31b-cloud --token-threshold 80000
```

### Understanding `--token-threshold` / `TOKEN_THRESHOLD`

`TOKEN_THRESHOLD` is the **context budget** mycc manages for the conversation history (system prompt + project context + all user/assistant/tool messages). It is **not** the model's maximum context window — it is a soft limit mycc enforces *below* that window via **auto-compaction**.

- As the conversation grows, mycc estimates the running token count. When it exceeds `TOKEN_THRESHOLD`, an **auto-compact** runs: the history is summarized (preserving accomplishments, current state, key decisions, and recent working memory) and replaced with a short summary pair, freeing the budget for new turns.
- This keeps the agent's attention on the active task instead of letting stale, verbose tool results accumulate until the model truncates or errors out.

**Why it must be less than the model's max context:**

The model's maximum context (e.g. 128k for `glm-5:cloud`, 131k for `deepseek-chat`) is the hard ceiling the provider enforces — requests beyond it are rejected or silently truncated. `TOKEN_THRESHOLD` should sit comfortably *below* that ceiling because:

1. **Headroom for the current turn** — the threshold is checked *before* the next LLM call. The agent's reply (which can be long, including tool-call definitions and reasoning) plus any tool results generated this turn are appended *after* the check, so they need to fit inside the remaining gap between `TOKEN_THRESHOLD` and the model's max context.
2. **Headroom for tools and overhead** — the full tool schema (30+ tool definitions), system prompt, and project context (README, mindmap instructions) are sent on every call and consume tokens not fully captured by the running estimate. Leaving a buffer prevents edge-case overflow.
3. **Avoid provider-side truncation** — if `TOKEN_THRESHOLD` were set at or above the model's max context, auto-compact would never trigger in time, and the provider would reject the oversized request (a hard failure) rather than mycc summarizing gracefully (a soft recovery).

**Rule of thumb:** set `TOKEN_THRESHOLD` to roughly **70–80% of the model's max context**. For example, with a 128k-context model, `--token-threshold 80000`–`100000` leaves ample headroom for the current turn, tool schemas, and overhead while still maximizing the usable history before compaction kicks in.

> **See also:** [`docs/loop/compact-working-memory.md`](docs/loop/compact-working-memory.md) — details the auto-compact mechanism, the LLM-stage compaction, and the working-memory focus extraction that preserves recent focus across compaction.

## Debug Flags

mycc provides several `--debug-*` flags for investigating specific subsystems:

| Flag | Effect |
|------|--------|
| `--debug-tp` | **Triologue Parity** — when a role transition violation occurs (e.g., `tool → user` without an `assistant` bridge), throw an error with a stack trace instead of auto-recovering. Useful when developing the auto-fixer or debugging `triologue.ts`. |
| `--debug-eval` | **Expression Evaluation** — prints the parsed AST tree for each hook condition expression during evaluation. Useful when developing hookish skills with custom `when` conditions in `evaluator.ts`. |
| `--disable-crossroad` | **Skip Crossroad** — disables turning-word detection entirely. No truncation, no continuation generation. Use when crossroad fires false positives (e.g. when the LLM's output legitimately mentions a word matching a turning pattern, such as a state name). |
| `--debug-ansi` | **Force Plain Output** — force the plain (no-TTY) output path even inside a real terminal: the spinner, progress bars and colour are suppressed, exactly as if stdout were piped or redirected. Use it to reproduce/verify the piped-output behaviour interactively. Equivalent to setting `MYCC_DEBUG_ANSI=true`. |
| `--debug-autofly` | **Autofly Debug** — arms the autofly gate at the PROMPT stage so auto mode engages once the per-turn LLM-stage streak meets the threshold (`--autofly=N`, default 3), without requiring an active peer channel. Useful for testing auto-mode engagement in isolation. |
| `--debug-wire` | **Wire Debug** — test-only escape hatch (`MYCC_WIRE_ALLOW_LOCAL`): allows `peer_connect` to a same-store / self peer (same-machine smoke test). Not for production. |

Combine with `-v` (verbose) for maximum detail:
```bash
mycc -v --debug-tp --debug-eval
```

## Key Concepts

See the following documentation for detailed explanations:

- **Agent Loop**: `docs/loop/agent-loop.md` - STAR principle, microCompact, autoCompact, todo nudging
- **Child Process Teammates**: `docs/context/child-context.md` - IPC, state machine, auto-claim
- **Dynamic Loading**: `docs/tools/dynamic-loading.md` - Hot-reload, tool scopes, skill format
- **Mindmap**: `docs/mindmap/mindmap-design.md` - Knowledge navigation, A-N-C-E summarization, process isolation
- **Remote Peer Wire**: `docs/peers/remote-peer-protocol.md` - Cross-machine peer connections, dialer/acceptor, pair-dedupe, optional wire token

## Day-to-day Workflow as a user

1. open up the terminal and `cd` to the target folder
2. run `mycc` and wait for the `agent >> ` prompt to show
3. type something to instruct LLM to work for you
4. check the output and iterate
5. **If you find LLM go astray, hit ESC to interrupt (enter neglected mode), then wait for the prompt to show again to chat.**
6. Once finished work, hit ENTER at the prompt to exit, or use Ctrl + C anytime to quit the app.

## NOTE TO THE MYCC (yourself!)

You are reading this doc because the agent-loop has injected it into your context.

This repo is the source code that YOU run. You can modify it to improve yourself.

The changes you performed will be effective in the new instance, not you. So it's relatively
safe to edit. The web part is the exception: it uses HotModuleReload, so changes will be 
reflected in real time.

MYCC is under active development, so it's common that you modify / refactor existing behavior
to enable / unlock / support new features. Pay attention to the observability when you edit.

**This repo should enable the skill manager.** Load the "lfplater-skill-manager" for more info.

## License

MIT
