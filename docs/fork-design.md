# fork slash command - design doc

> **状态：已实施。** 见 `src/slashes/fork.ts`。保留为设计文档。

The `/fork` slash command gives mycc a way to `run a new version of itself` in parallel.

## workflow

1. In a mycc instance, after the code changes, the user enters `/fork` in the prompt and submit
2. It is interpreted as a slash command.
3. Mycc will get the current session id, open up the terminal, and simulate a `mycc --from <session-id>` inside
that terminal (with cwd equal the current cwd). `--from <id>` reads the old session read-only, re-understands
it via the LLM, and starts a BRAND NEW session pre-filled with that context — the old session is sealed and
never written to. So the forked instance runs in parallel with its own session id and triologue file.
4. The old mycc instance is kept as-is, so two versions of mycc can run in parallel.

## Implementation details

`src/slashes/fork.ts` implements the command with platform-specific handling:
- **Windows**: uses `node.exe` + `bin/mycc.js` (single-quoted PowerShell paths), opens via `wt.exe` with `-EncodedCommand` (Base64 UTF-16LE) to avoid `wt.exe`'s `;` splitting bug.
- **Unix**: uses `node_modules/.bin/tsx` + `src/index.ts`, opens via native terminal emulator.
- Supports `--env KEY=VALUE` flags to forward environment variables to the forked instance.
- Forwards `--skip-healthcheck` if the current instance was started with it.
- Falls back to printing manual instructions if no terminal can be opened automatically.

## Special notice

To test this functionality, you need to use the screen tool rather than the tmux tool, because otherwise you cannot
see what's going on inside the new terminal.