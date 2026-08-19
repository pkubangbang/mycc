# Configuration

Configuration is stored in `.env` files:

| Level | Location | Scope |
|-------|----------|-------|
| **User** | `~/.mycc-store/.env` | All projects |
| **Project** | `.mycc/.env` | Current project only |

## Key Environment Variables

| Variable | Purpose |
|----------|---------|
| `OLLAMA_HOST` | Ollama server URL (default: http://127.0.0.1:11434) |
| `OLLAMA_MODEL` | Chat model (default: glm-5:cloud) |
| `OLLAMA_VISION_MODEL` | Vision model for screen/image tools |
| `OLLAMA_EMBEDDING_MODEL` | Embedding model (default: nomic-embed-text) |
| `OLLAMA_API_KEY` | API key for cloud features (optional) |
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `DEEPSEEK_MODEL` | DeepSeek model (default: deepseek-chat) |
| `TOKEN_THRESHOLD` | Context limit for auto-compaction (default: 50000) |
| `EDITOR` | Text editor for multiline input |

## CLI Flags

All environment variables can be overridden via CLI flags. These take
highest priority, overriding `.env` files and system environment variables.

| Flag | Env Variable | Description |
|------|-------------|-------------|
| `--ollama-host` | `OLLAMA_HOST` | Ollama server URL |
| `--ollama-api-key` | `OLLAMA_API_KEY` | Ollama API key for cloud features |
| `--ollama-model` | `OLLAMA_MODEL` | Ollama chat model |
| `--ollama-vision-model` | `OLLAMA_VISION_MODEL` | Ollama vision model |
| `--ollama-embedding-model` | `OLLAMA_EMBEDDING_MODEL` | Embedding model |
| `--deepseek-host` | `DEEPSEEK_HOST` | DeepSeek API endpoint |
| `--deepseek-api-key` | `DEEPSEEK_API_KEY` | DeepSeek API key |
| `--deepseek-model` | `DEEPSEEK_MODEL` | DeepSeek model name |
| `--api-provider` | `API_PROVIDER` | API provider: "ollama" or "deepseek" |
| `--token-threshold` | `TOKEN_THRESHOLD` | Context limit threshold |
| `--editor` | `EDITOR` | Text editor for file editing |
| `--serve [port]` | — | Start the Web UI (bare flag = default port 3173) |
| `--port <n>` | — | Port for the Web UI |
| `--host <addr>` | — | Bind address for the Web UI (default: localhost) |
| `--auto` | — | Autonomous mode (lead auto-replies to mail, no human at terminal) |
| `--skip-healthcheck` | — | Skip the Ollama health check for faster startup |
| `-v` / `--verbose` | — | Verbose logging |

## Override Priority

CLI flags (highest) > system environment variables > project `.mycc/.env`
> user `~/.mycc-store/.env` (lowest).

## See also

- `ollama-dependencies.md` — which features break if Ollama is absent.
- `launching-and-locating.md` — launch commands and flags in context.
- SKILL.md — the glossary overview.