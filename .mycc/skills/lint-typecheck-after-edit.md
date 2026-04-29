---
name: lint-typecheck-after-edit
description: >
  Run lint and typecheck before the agent finishes, if code changes were made without running quality checks.
  This ensures code quality and type safety before task completion.
when: before LLM finishes reply (no tool calls pending), if edit_file or write_file was used this session and lint/typecheck was not run
---

# Code Quality Checks After Edits

This hook **injects** lint/typecheck before the agent stops, ensuring code quality checks run automatically.

## Behavior

When the agent tries to finish (no more tool calls) after making code changes:
- **If lint/typecheck was run**: The agent can finish normally with its summary reply
- **If lint/typecheck was NOT run**: The hook injects `pnpm lint && pnpm typecheck` before stopping

## How It Works

1. Agent makes code changes (edit_file/write_file)
2. Agent finishes work (no more tool calls)
3. Hook detects missing quality checks
4. Hook injects lint/typecheck tool call
5. Tool executes, result added to conversation
6. Agent gets another turn to produce a summary

This preserves the "head up reply" - the agent sees the lint/typecheck result and can summarize it naturally.

## Required Commands

1. **Lint Check**:
   ```
   pnpm lint
   ```
   - Catches code style issues
   - Identifies unused variables
   - Enforces consistent formatting

2. **Type Check**:
   ```
   pnpm typecheck
   ```
   - Verifies TypeScript types
   - Catches type errors
   - Ensures type safety

## Workflow

1. Make code changes (edit_file/write_file)
2. Run `pnpm lint && pnpm typecheck` (or let the hook inject it)
3. If checks fail, fix the issues
4. Finish with a summary of what was done

## Important

- The hook injects quality checks automatically if not run
- Agent produces a natural summary after seeing the check results
- Run checks BEFORE you're ready to finish to control timing