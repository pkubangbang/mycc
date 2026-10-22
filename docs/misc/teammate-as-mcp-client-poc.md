# Teammate as a Dedicated MCP Client — PoC Plan

> **STATUS: NOT IMPLEMENTED — kept for the record of the PoC.**
>
> This document is a design/feasibility record only. Nothing described here
> has been built. It is retained so the analysis (and the decisions behind
> it) can be revisited or handed off later. Do not treat any section below
> as describing existing behavior.

**Date:** 2026-10-13
**Question answered:** Is it feasible to make a mycc teammate act as a
dedicated MCP client, so the lead queries the teammate and the teammate
replies with what the MCP server returns?

**Verdict:** **Yes, feasible.** The cleanest shape is a teammate that owns a
persistent MCP (stdio JSON-RPC) client and is reached by the lead through the
existing `mail_to`. The teammate's value is not relaying bytes — it is a
**context firewall** (MCP tools such as `codegraph_explore` return large
verbatim payloads; the teammate distills them before the lead ever sees them)
plus **process isolation** (a hung MCP server blocks only the child). It is
optional for codegraph specifically, which also ships a CLI.

---

## 1. Motivation

The lead could call an MCP server directly, but a dedicated teammate offers:

| Aspect | Lead-side MCP call only | Teammate as MCP specialist |
|---|---|---|
| Round-trips | 1 (same turn) | 2 (async: mail out, mail back) |
| Lead context | MCP payload lands **raw** in lead | `summarize → return`; lead stays lean |
| Failure blast radius | Hang blocks the lead | Hang confined to the child |
| Parallelism | Serial | N specialists → N servers, concurrent |
| Cost | Cheapest | +one LLM turn per query |

Because MCP payloads are large, the context-firewall benefit outweighs the
extra round-trip.

## 2. Feasibility evidence (verified in-tree)

- Teammates are **forked child processes** managed by `TeamManager`
  (`src/context/parent/team.ts`), each with its own `ChildContext`
  (`src/context/child-context.ts`).
- A teammate's tool list comes from `silentLoader.getToolsForScope('child')`
  — loaded at `src/context/teammate-worker.ts:857`, consumed at `:240`,
  executed at `:530`.
- Scope filtering is `entry.tool.scope.includes(scope)`
  (`src/context/shared/loader.ts`).
- **Custom project tools** load from `.mycc/tools/*.ts|js`
  (`loadDynamicTools`); **user tools** from `~/.mycc-store/tools/`. Built-ins
  live in `src/context/shared/registry.ts`.
- **No MCP tool or MCP SDK exists in mycc** — searched all `src/**/*.ts` and
  `docs/`, `skills/`, `*.md`: zero `mcp` references; `@modelcontextprotocol/*`
  is not in `package.json` nor installed. So any MCP client must be written,
  and it must be hand-rolled JSON-RPC over stdio (no new dependency needed).
- `bash` is `scope: ['main', 'child']`, so a teammate can already spawn
  processes; a custom tool handler runs arbitrary code too.
- Idle teammates stay alive, poll mail every 5s, and **wake on new mail**
  (`docs/context/child-context.md`) — so a persistent specialist responder works
  without new infrastructure.
- `codegraph` (`@colbymchenry/codegraph@1.6.2`) exposes both a **CLI** and an
  **MCP server** (`codegraph serve --mcp`, stdio transport) with a single tool
  `codegraph_explore`; the CLI's `explore`/`query`/`callers`/`callees` emit the
  same output as the MCP tool.

## 3. Tool counts (before the change)

- Built-in registry: **50** tools.
- Teammate sees `scope.includes('child')`: **37**.
  - 36 are `['main','child']`; 1 is `['child']`-only (`question`).
  - 13 are `['main']`-only and therefore **hidden** from teammates:
    `todo_pinning, tm_create, tm_remove, tm_await, broadcast, hand_over,
    plan_on, plan_off, recap, peer_list, peer_connect,
    peer_disconnect`.
- Lead sees `36 + 13 = 49`.
- Custom tools present: **0** (`.mycc/tools/` and `~/.mycc-store/tools/` are
  both empty).

**Before / after for this proposal:** teammate `37 → 38` (one new
`child`-scoped `mcp_call`). The child picks up the new tool only at its **own**
startup (`silentLoader.loadAll()`), hence the ordering constraint in §5.

## 4. Architecture

```
lead  --mail_to("mcp-echo", "explore: crossroad lifecycle")-->  specialist (child)
                                                                   │
                                              silentLoader.execute('mcp_call', …)
                                                                   │  stdio JSON-RPC
                                                                   ▼
                                                        codegraph serve --mcp
                                                    initialize → tools/call
                                                                   │
lead <--mail_to("lead", <distilled answer>)------------------------┘
```

This maps onto the `coordination` skill's **Scratchpad / hub-with-memory**
pattern: lead mails a query → specialist answers against an external "memory"
(the MCP server).

## 5. Proposed changes

> All of the following is **plan only — not implemented**.

**New — `.mycc/tools/mcp-call.ts`** (project-level; promote to
`~/.mycc-store/tools/` later for reuse). `export default { … } as ToolDefinition`:

- `name: 'mcp_call'`, `scope: ['child']` in production (debug as
  `['main','child']` first).
- `input_schema`: `server` (config key), `method` (`tools/list` | `tools/call`
  | `resources/read` | …), `tool?` (e.g. `codegraph_explore`), `arguments?`
  (JSON string), `timeoutMs?`.
- `handler: async (ctx, args)`: module-level `Map<serverName, McpClient>` →
  lazily `spawn` + `initialize` + `notifications/initialized` once, then per
  call write a newline-delimited `{jsonrpc:"2.0",id,method,params}` and resolve
  the matching `id` from buffered stdout; drain stderr; kill on timeout; return
  the result text; log via `ctx.core.brief`. (Persistent session — not one
  process per call.)

**New — `.mycc/mcp-servers.json`:**

```json
{ "codegraph": { "command": "codegraph", "args": ["serve", "--mcp", "--no-watch", "-p", "."] } }
```

**New — `.mycc/skills/mcp-bridge/SKILL.md`:** the protocol contract (how the
lead phrases a query mail; how the specialist replies; "mail the lead only; do
not auto-claim unrelated issues"). Content problem-focused only.

**No changes needed** to `child-context.ts`, `teammate-worker.ts`, `loader.ts`,
or `registry.ts` — the custom-tool path already covers this.

### Ordering constraint

The child loads tools at its **own** startup, so a teammate spawned before
`mcp-call.ts` exists will never see it (the lead's loader hot-reloads; the
child's does not). Order: **write tool → spawn teammate**.

## 6. Phased implementation plan

**Phase 0 — prove the pattern with zero new tools.** A teammate already runs
`bash`, and `codegraph` has a CLI emitting the same output as its MCP tool
(`codegraph explore`, `codegraph query`, `codegraph callers`). So a teammate
can answer the lead's queries today — no new tool, no IPC, no protocol code.
This de-risks the idea in minutes and dissolves most of the complexity: the
generic `mcp_call` tool is only needed for *arbitrary* MCP servers and a
*persistent* JSON-RPC session.

**Phase 1 — the generic `mcp_call` tool.** Add `mcp-call.ts` +
`mcp-servers.json` as in §5.

**Phase 2 — bridge skill + spawn contract.** Add `.mycc/skills/mcp-bridge/`
and spawn the specialist (name e.g. `mcp-echo`, role "MCP query specialist")
**after** the tool file exists.

**Phase 3 — guardrails, test, rollout.**
1. Test `mcp_call` from the lead (`scope: ['main','child']`), then tighten to
   `['child']`.
2. Whitelist the spawned command; do **not** take `command` from LLM input —
   custom tools bypass the bash-judge grant system.
3. Promote to `~/.mycc-store/tools/` once stable; commit gate is `pnpm lint`
   → `pnpm test` (bash tool) before `git_commit`.

### Verification

`mcp_call` returns real `initialize` / `tools/list` / `tools/call` JSON from
`codegraph serve --mcp`; the specialist's mail reply is a distilled answer; the
lead context shows only the summary, not the raw payload.

## 7. Risks / caveats (pitfall-aware)

- **Auto-claim side effect.** An idle teammate auto-claims any unowned
  `pending` issue (`enterIdleState`, `teammate-worker.ts`), independent of
  role. Keep the specialist busy, or avoid leaving stray pending issues; the
  skill prompt cannot override this loop.
- **STOP/AWAIT mail-loop freeze.** Teammate mail during STOP/AWAIT is a known
  tight-loop trap (STOP must only accept bounded reasons `['all done',
  'timeout','esc']`, never `mail`/`steering`). The specialist's replies must be
  sparse; answers arrive **next turn**, not same-turn.
- **Custom tools bypass the grant system.** `mcp_call` spawns processes without
  the dangerous-command gate; hardcode/whitelist the command rather than taking
  it from LLM input.
- **Async ergonomics.** Sync same-turn answers would require a new parent→child
  request/response IPC (current parent→child messages are `spawn`, `message`,
  `shutdown`, `mode_change` only) — out of scope.
- **Worktree cwd.** If the specialist runs in `.worktrees/<name>`, pass
  `-p <project-root>` so codegraph finds the index.
- **Stale scope comments.** A prior audit found `plan_on.ts` header comments
  drifting from the real `scope` array; keep `mcp-call.ts`'s comment and its
  `scope` field in sync.

## 8. Assumptions

Node 24 and `codegraph` on PATH (both confirmed); **async (Scratchpad)
semantics** chosen as the single approach; the custom-tool path is preferred
over modifying `src/`; codegraph is the first server, with the config left
generic for others.

## 9. Key references

- `src/context/child-context.ts`, `src/context/teammate-worker.ts`,
  `src/context/shared/loader.ts`, `src/context/shared/registry.ts`
- `src/tools/tm_create.ts`, `src/context/parent/team.ts`,
  `docs/context/child-context.md`, `docs/tools/dynamic-loading.md`
- `skills/coordination/` (Scratchpad / hub-with-memory pattern),
  `skills/add-tool/`
- `@colbymchenry/codegraph@1.6.2` (`codegraph serve --mcp`)
