# Changelog Archive - June 2026

This file contains archived changelog entries from the mycc project for June 2026.
For current changelog, see `changelog-todo.md`.

## 2026-06-02
### Fixes
- **CJK Alignment**: Fixed string-width for CJK-aware banner alignment in `mycc_title`.
- **Checkpoint/Recap**: Refactored checkpoint/recap with transparent recap, forkChat, and teammate cleanup.

## 2026-06-03
### Features & Fixes
- **Multi-line**: Chinese "、" (enumeration comma) at end of line now also triggers multi-line editing.
- **Hook**: Checkpoint/recap isolation failures now return COLLECT instead of STOP.
- **skill_load**: Added retrospect showing skill location and level on load.

## 2026-06-05
### Fixes
- **read_file**: Show head+tail preview for minified/single-long-line files.

## 2026-06-22
### Fixes
- **Fork on Windows**: Fixed `/fork` command on Windows. Three root causes: (1) `mycc` not on PATH → `0x80070002`; (2) `shell:true` in open-terminal.ts wrapped command in `cmd.exe /d /s /c` which broke nested quoting and created double windows; (3) `wt.exe` has a known bug (microsoft/terminal#13264) where it splits on `;` even inside quoted arguments, causing the forked command to be treated as two separate wt actions. Fixed by using `node.exe + bin/mycc.js` (no PATH dependency), removing `shell:true` from Windows terminal configs (spawn powershell directly), and encoding the PowerShell script as UTF-16LE Base64 via `-EncodedCommand` (eliminates all `;`, spaces, and quotes from the command line).
- **Loader**: Normalize skill keywords to array on parse to prevent TypeError when keywords is a single string.

## 2026-06-23
### Features
- **Background Tools**: Expose bg tool output, grant integration, killed status, and output cap for better background task management.

### Documentation
- **environment-detection**: Document PowerShell lacks `&&` operator in cheatsheet.

## 2026-06-24
### Features
- **Crossroad**: Shorten continuations and log alternatives with selection for better decision tracking.
- **ESC Cancel**: Allow ESC to cancel prompt input and return to fresh prompt instead of ignoring it.
- **Walkthrough Docs**: Added walkthrough documentation for common workflows.

### Fixes
- **Hook/Crossroad**: Restructure crossroad as first-class branch, fix `duplicate_assistant` TP recovery.
- **Setup**: Preserve all config vars in `.env`, not just current provider's.
- **Config**: Inline `.env` parsing, remove `dotenv` dependency.
- **Config**: Read `args.setup` directly instead of `process.env.MYCC_SETUP`.
- **Config**: Read `--session` from minimist args instead of `process.env`.
- **Path Normalization**: Normalize path separators before regex in `ensureSameTeammate`.
- **Mail**: Allow `eta=0` in `mail_to` tool for non-budget messages.
- **Grants**: Allow child process writes to project root when no worktree assigned.
- **Prompts**: Add permission rule for lead and worktree guidance for teammates.
- **Team**: Polish `eta_update` to show styled banner with bg-color.
- **Teammate Idle**: Update teammate idle logic for better state management.

### Tests
- **Unit Tests**: Add 81 new unit tests and fix bg-create test mock.
- **bg-create**: Add `bg-create.test.ts` (13 tests) for background task creation tool.

## 2026-06-25
### Features
- **CLI Config Flags**: All env-configurable vars are now available as CLI flags via minimist. New flags: `--ollama-host`, `--ollama-api-key`, `--ollama-model`, `--ollama-vision-model`, `--ollama-embedding-model`, `--deepseek-host`, `--deepseek-api-key`, `--deepseek-model`, `--api-provider`, `--token-threshold`, `--editor`, `--skill-match-threshold`. These override `.env` files and system environment variables with highest priority.
- **Session Reorganization**: All session files now stored in session subdirectories for cleaner organization.

### Documentation
- **README**: Added "Configuration Flags" section documenting all CLI flags and their env variable mappings.

## 2026-06-26
### Features
- **Plan Mode**: Update `plan_on` to be more detective to free-form replies; updated agent prompts for team plan mode.
### Fixes
- **plan_on**: Fixed file path detection + `awaitTeammate` mailbox deadlock.

## 2026-06-29
### Features
- **Intent Lang**: Added `FIND` verb to the VERB vocabulary.
- **Wiki**: Added `/wiki import` and `/wiki export` slash commands.
### Refactoring & Fixes
- **Checkpoint**: Capture "before" state upfront and reference it in recap.
- **Clear Session**: Double Ctrl+L now also clears todos and issues.
- **Code Review**: Four minor corrections from code review.
- **Env Detection**: Add mycc tool/skill layers to env-detection skill; fix lint in `handleImport`.

## 2026-06-30
### Features
- **Startup**: Show cwd on start.
### Refactoring
- **Skills**: Remove built-in layer references from built-in skills; add project-level `environment-detection-extra` skill.