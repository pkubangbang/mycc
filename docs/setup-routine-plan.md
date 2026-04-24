# MyCC Setup Routine Plan

## Overview

Interactive setup wizard for first-time installation or environment recovery when mycc cannot start due to misconfigured environment variables.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OLLAMA_HOST` | No | `http://127.0.0.1:11434` | Ollama server URL |
| `OLLAMA_MODEL` | No | `glm-5:cloud` | General/chat model |
| `OLLAMA_VISION_MODEL` | No | `none` | Vision model (set to "none" to disable) |
| `OLLAMA_EMBEDDING_MODEL` | No | (empty) | Embedding model for semantic search/RAG |
| `OLLAMA_API_KEY` | No | (empty) | API key for cloud features (sensitive) |
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
4. **Interactive prompts** for each configuration value
5. **Pull models** via `ollama pull` (OLLAMA_MODEL, OLLAMA_VISION_MODEL, OLLAMA_EMBEDDING_MODEL)
6. **Write `.env` file** at chosen location
7. **Print success** message

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

After configuration, automatically pull:
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
├── wizard.ts         # Interactive readline prompts
├── prompts.ts        # Prompt definitions and validation
├── paths.ts          # Cross-platform path resolution
├── display.ts        # Current settings display with redaction
├── models.ts         # Model pulling via ollama
├── ollama.ts         # Ollama binary detection and service checks
└── editor.ts         # Platform-specific editor defaults
```

## Modified Files

| File | Changes |
|------|---------|
| `src/index.ts` | Add `--setup` flag handling, show setup instruction on env validation failure |
| `src/config.ts` | Export `ENV_REQUIREMENTS` for reuse |

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