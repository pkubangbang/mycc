# AGENTS.md

This file holds project-level invariants for the agent, injected **verbatim**
into the project context on every (re)build (resolved case- and
plural-insensitively — `AGENT.md` and `AGENTS.md` are the same document, so do
not create a second file with a different spelling). Two parts live here:

1. **Toolchain invariants** — how to build/test this repo (the Vite+ block above).
2. **Agent behavior** — how the agent should behave when it *speaks*.

Reference material that grows belongs in `MYCC.md` instead: it is compiled into
the mindmap and retrieved on demand, so size is not the constraint there.

## Output Behavior

**CRITICAL**: you MUST follow these instructions when you respond.
- When you detect dilemma, use the brief tool to state it clearly with a low confidence (1~5).
- Avoid repeating the content that has been output by the brief tool.
- Do NOT explain, comment on, or narrate your response to hook/skill [REMINDER] or [Hook] notifications. If a reminder tells you to do something, do it silently. If it is informational, acknowledge it implicitly by continuing your task.

### High-Quality Explanations
**Before output**, double check the resources you used to ensure they exist.
When explaining code changes, design choices, or analysis results:

1. Start with the conclusion - State what changed or what you recommend in ONE line before any explanation.
2. Provide your evidence - Each argument should cover a distinct aspect, and together they should fully support your conclusion.
3. Outline the difference - Use "BEFORE / AFTER" to say it clearly.
4. Avoid filler narration - "Let me take a look...", "I can see that...", "What this does is..." → delete these. Just say what the result is.
5. Cite your sources - For non-trivial explorations (multiple files, web searches), briefly list key resources you consulted at the end, marked: IN USE / NOT RELEVANT / NOT FOUND.


<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Running Scripts

Run TypeScript and JavaScript files with `vpx <file>`, for example `vpx ./scripts/seed.ts --dry-run`. It handles enums, decorators, JSX, and tsconfig `paths`, so do not add `tsx` or `ts-node` to run scripts. `vpx --watch <file>` reruns the file when a file it uses changes, in place of `tsx watch`. `vp node <file>` runs plain Node.js.

## Tool Versions

Run `vp toolchain` to show versions and relationships in the active Vite+
release. Add a tool name to select part of the graph. For example, run
`vp toolchain vite`. Use `--global` to ignore the local `vite-plus` package. Use
`vp why <package>` to show the package-manager dependency graph.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->
