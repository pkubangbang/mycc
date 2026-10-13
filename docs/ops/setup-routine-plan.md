# MyCC Setup Routine Plan

> **Status**: Implemented. The setup wizard now supports both Ollama and DeepSeek providers via `API_PROVIDER` selection. See `src/setup/prompts.ts` for the current prompt definitions.

## Overview

Interactive setup wizard for first-time installation or environment recovery when mycc cannot start due to misconfigured environment variables. The wizard prompts for provider selection (Ollama or DeepSeek) first, then adapts subsequent prompts based on the choice.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OLLAMA_HOST` | No | `http://127.0.0.1:11434` | Ollama server URL (always asked — embeddings use Ollama) |
| `OLLAMA_EMBEDDING_MODEL` | No | `nomic-embed-text` | Embedding model for semantic search/RAG (always Ollama) |
| `OLLAMA_MODEL` | No | `glm-5:cloud` | General/chat model (Ollama provider) |
| `OLLAMA_VISION_MODEL` | No | `none` | Vision model (set to "none" to disable; Ollama provider) |
| `OLLAMA_API_KEY` | No | (empty) | API key for cloud features (sensitive; Ollama provider) |
| `API_PROVIDER` | No | `ollama` | Provider selection: `ollama` or `deepseek` |
| `DEEPSEEK_HOST` | No | `https://api.deepseek.com` | DeepSeek API endpoint (DeepSeek provider) |
| `DEEPSEEK_API_KEY` | No | (empty) | DeepSeek API key (sensitive; DeepSeek provider) |
| `DEEPSEEK_MODEL` | No | `deepseek-chat` | DeepSeek model name (DeepSeek provider) |
| `TOKEN_THRESHOLD` | No | `50000` | Context limit threshold |
| `EDITOR` | No | Platform default | Text editor for file editing |

## User Flow

### 1. Detection Flow

When environment validation fails:
1. Print user-friendly error listing missing variables
2. Instruct user to run `mycc --setup`
3. Exit with code 2 (setup required)

### 2. Setup Flow

When user runs `mycc --setup`:

1. **Display current settings** - Show all env vars with redacted sensitive values, indicate source (`[user]`, `[project]`, `[default]`, or `(not set)`)
2. **Choose config location** - User-level (`~/.mycc-store/.env`) or project-level (`./.mycc/.env`)
3. **Create directory** if needed
4. **Choose provider** - Ollama (1) or DeepSeek (2)
5. **Interactive prompts** for each configuration value (adapted based on provider choice; OLLAMA_HOST and OLLAMA_EMBEDDING_MODEL always asked since embeddings use Ollama)
6. **Pull models** via `ollama pull` (Ollama provider only; skipped for DeepSeek — cloud-based models)
7. **Write `.env` file** at chosen location
8. **Print success** message (reflects selected provider)

## Config Location

| Option | Path | Scope |
|--------|------|-------|
| User-level | `~/.mycc-store/.env` | Global, all projects |
| Project-level | `./.mycc/.env` | Current project only |

Precedence: Project-level overrides user-level (loaded second, takes priority).

## API Key Redaction

Sensitive values displayed as `****xxxx` (last 4 chars visible). On re-run:
- Empty input = keep existing value
- New value = use new value

## Model Pulling

After configuration, automatically pull (Ollama provider only; skipped for DeepSeek since models are cloud-based):
1. `OLLAMA_MODEL` (required) - warn if pull fails
2. `OLLAMA_VISION_MODEL` (if set and not "none") - silent failure
3. `OLLAMA_EMBEDDING_MODEL` (if set) - silent failure

Check if model exists first via `ollama list`, skip if already pulled.

## Cross-Platform Compatibility

| Platform | Home Directory | Default Editor | Notes |
|----------|----------------|----------------|-------|
| Linux | `/home/{user}` | `nano` | Primary target |
| macOS | `/Users/{user}` | `nano` | Same approach as Linux |
| Windows | `C:\Users\{user}` | `notepad` | Use `where` instead of `which` |

Path handling:
- Use `path.join()` for all paths (handles platform separators)
- Use `os.homedir()` for home directory
- Use `os.EOL` for line endings in `.env` file
- Use `shell: true` in spawn options on Windows for PATH resolution

Editor suggestions by platform:
- Linux/macOS: `nano`, `code`, `vim`, `emacs`
- Windows: `notepad`, `code`, `notepad++`, `vim`

## Edge Cases

1. **Non-interactive terminal**: Show error and instruct manual setup
2. **Permission denied**: Show directory permissions error
3. **Network timeout**: Allow continuing without connection test
4. **Both configs exist**: Show warning about precedence, prompt which to update
5. **Running from home directory**: Warn that project-level doesn't make sense, suggest user-level
6. **Ollama not installed**: Warn and skip model pull, continue with config
7. **CI environment**: Detect `CI` or `CONTINUOUS_INTEGRATION` env vars, skip interactive wizard

## File Structure

```
src/setup/
├── index.ts          # Entry point, orchestrates setup flow
├── wizard.ts         # Interactive readline prompts, provider selection
├── prompts.ts        # Prompt definitions (Ollama + DeepSeek), validation, ENV_REQUIREMENTS
├── paths.ts          # Cross-platform path resolution
├── display.ts        # Current settings display with redaction
├── models.ts         # Model pulling via ollama (skipped for DeepSeek)
├── ollama-setup.ts   # Ollama binary detection and service checks
└── editor.ts         # Platform-specific editor defaults
```

## Modified Files

| File | Changes |
|------|---------|
| `src/index.ts` | Add `--setup` flag handling, show setup instruction on env validation failure |
| `src/config.ts` | Export `ENV_REQUIREMENTS` for reuse (imported from `src/setup/prompts.ts`) |

## Success Criteria

1. ✅ `mycc --setup` launches interactive wizard
2. ✅ Displays current settings with redacted sensitive values
3. ✅ Prompts for config location (user vs project)
4. ✅ Pulls configured models automatically
5. ✅ Generates valid `.env` file
6. ✅ Works on Linux, macOS, and Windows
7. ✅ Preserves existing config on re-run (with redaction)
8. ✅ Shows clear error when setup is needed

## Implementation Phases

**Phase 1: Core**
- Create setup module structure
- Implement readline-based wizard
- Integrate with coordinator entry point

**Phase 2: Polish**
- Add input validation
- Add model pulling
- Handle edge cases

**Phase 3: Testing**
- Test on Linux, macOS, Windows
- Test fresh install and re-run scenarios
- Manual verification