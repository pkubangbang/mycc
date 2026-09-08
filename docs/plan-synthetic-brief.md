# Plan: Hide synthetic brief messages from the WebUI chat log

## Problem

Some `brief` messages shown in the WebUI chat log are **synthetic** — they are
produced by hook machinery (or other routine components) rather than the LLM
itself. They clutter the chat log. We add a `synthetic: true` property to these
briefs at emission time and hide them in the WebUI.

## Design decision: opts object (backward compatible)

All `brief()` signatures gain a final optional `opts?: { synthetic?: boolean }`
parameter. This is backward compatible: ~200 existing call sites keep working
unchanged; only the synthetic emitters opt in. (Alternative — a 6th positional
param — was rejected: unreadable and easy to mis-order.)

Definition of *synthetic*: the message was emitted by mycc's own machinery
(hook engine, debug evaluator) **on its own initiative**, not as a direct
rendering of LLM-authored content or a real tool result. Teammate-forwarded
briefs (`@name/tool` via IPC `log`), tool-result lines, and user-facing status
lines are **not** synthetic.

## Flag flow (end-to-end)

```
emitter (hook-executor / evaluator)
  └─ ctx.core.brief(level, tool, msg, detail?, { synthetic: true })
       ├─ Parent: Core.brief → agentIO.brief(..., opts)
       │    └─ outputCallback(method, [message], tool, detail, synthetic)
       │         └─ activate.ts → hub.broadcast(method, text, label, detail, synthetic)
       │              └─ ClientRegistry.broadcast → LogEntry.synthetic + WS payload.synthetic
       │                   ├─ live: ws.onmessage → applyServerMessage → SKIP
       │                   └─ /history: messageLog entry with synthetic → SKIP in fetchHistory()
       └─ Child: ChildCore.brief → ipc.sendNotification('log', { ..., synthetic })
            └─ team.ts handleChildMessage 'log' → forwards synthetic into label brief
```

Terminal output is untouched — synthetic briefs still print in the terminal
(they are useful while developing); only the WebUI chat log hides them.

## File-by-file changes

### Backend — signature & plumbing

1. **`src/types.ts` (~line 351, CoreModule interface)**
   ```ts
   brief(level: 'info' | 'warn' | 'error', tool: string, message: string, detail?: string,
         opts?: { synthetic?: boolean }): void;
   ```

2. **`src/loop/agent-io.ts`**
   - `OutputCallback` type: add 5th param `synthetic?: boolean`.
   - `brief(...)`: accept `opts?: { synthetic?: boolean }`, pass
     `opts?.synthetic ?? false` as the 5th outputCallback arg.

3. **`src/context/parent/core.ts` (~line 122)** — pass `opts` through to
   `agentIO.brief`.

4. **`src/context/child/core.ts` (~line 27)** — `ChildCore.brief` adds
   `synthetic: opts?.synthetic ?? false` to the IPC `'log'`/`'error'`
   notification payloads.

5. **`src/context/parent/team.ts` (`handleChildMessage` 'log'/'error')** —
   read `msg.synthetic as boolean | undefined` and pass
   `{ synthetic }` into the forwarded `ctx.core.brief`.

6. **`src/serve/activate.ts` (~line 45)** — the outputCallback closure gains
   the `synthetic` param and forwards it: `hub.broadcast(method, text, label,
   detail, synthetic)`.

7. **`src/serve/serve-hub.ts`** — `broadcast(type, content, label?, detail?,
   synthetic?)` passes it through to `this.clients.broadcast(...)`.

8. **`src/serve/serve-clients.ts` (`ClientRegistry.broadcast`)** — accept
   `synthetic?: boolean`; when true, set `entry.synthetic = true` on the
   `LogEntry` and include `synthetic: true` in the WS JSON payload (omit
   when falsy — keeps the wire format unchanged for existing messages).

9. **`src/serve/serve-types.ts`** — `LogEntry` gains
   `synthetic?: boolean`.

### Frontend — filter

10. **`src/web/src/types.ts`** — `ChatMessage` gains
    `synthetic?: boolean`.

11. **`src/web/src/main.ts` (`fetchHistory`)** — extend the existing
    `.filter()` to also drop `m.synthetic` entries (same place as the
    steer-echo/file-upload drops).

12. **`src/web/src/message-dispatch.ts` (`applyServerMessage`)** — in the
    default branch, add the synthetic check AFTER the
    `prompt/card → working` phase transition but BEFORE the `@label` routing
    and `messages.push`: `if (msg.synthetic) return;`. This keeps phase
    semantics 100% intact (a synthetic hook brief still proves "the agent is
    working" if it arrives during a prompt/card phase) and only suppresses
    the chat-log entry.

### Emission sites — mark as synthetic

13. **`src/hook/hook-executor.ts`** — the 7 `ctx.core.brief('info', 'hook', …)`
    calls (COMPACT request, injectBefore, injectAfter, block, replace×2,
    message) each get `, { synthetic: true }`.

14. **`src/hook/evaluator.ts` (~line 370)** — the `--debug-eval` jsep-tree
    brief gets `{ synthetic: true }` (debug machinery output, fires only with
    the flag).

15. **`src/loop/checkpoint-recap.ts` (~line 171)** — the `checkpoint` brief
    (meta-tool bookkeeping, duplicated by the checkpoint tool result) gets
    `{ synthetic: true }`.

### Deliberately NOT synthetic

> **Design-review finding (correlation):** the flag is threaded through ONE
> shared pipeline (agentIO outputCallback → activate.ts → hub.broadcast →
> client fan-out) — all emitter sites consume the same primitive, so there is
> no per-emitter duplication to hoist further (scope question satisfied at
> the pipeline level). Ordering constraint: the type additions (1, 9, 10) must
> land before or with the emitter edits (13–15) or `tsc` fails; frontend
> filter (11–12) is independent and can land anytime after (10).

- `src/loop/states/llm.ts` empty-output synthetic **brief tool call** — it
  flows through the real `brief` tool (LLM-facing engagement prompt) and
  surfaces as a normal `[brief]` line; the terminal/WebUI distinction doesn't
  apply because it is emitted as a tool call, and hiding it would hide real
  brief traffic. Left untouched.
- `src/tools/brief.ts` (the LLM's own brief tool) — stays visible: it is the
  LLM's deliberate status channel.
- Teammate lifecycle briefs (`teammate_ready`, `eta_update`, exit/error) and
  forwarded teammate logs — real events, stay visible (the `@`-prefix routing
  already moves them into the teammate drawer).
- The `@`-prefix label routing happens **before** the synthetic check in
  message-dispatch; synthetic teammate forwards (currently none) would land in
  the drawer — acceptable and consistent.

## Tests

- **`src/tests/webui/message-dispatch.test.ts`** (exists — check name) — add
  cases: `synthetic:true` log not pushed to `messages`; still records
  `lastServerMsg`; phase transitions unaffected.
- **history filter** — if a pure function covers `fetchHistory`'s filter,
  add a case; otherwise covered by the dispatch tests + manual verify.
- Run: `pnpm vitest run src/tests/webui` (or the existing suite path) +
  `pnpm build` (or `npx tsc --noEmit`) for type safety.

## Verification

1. `pnpm build` — no type errors from the signature change.
2. Unit tests — dispatch filter + existing suite green.
3. Manual (`mycc-online-hotfix` style live test): start `pnpm start
   --skip-healthcheck`, `/serve`, trigger a hook (e.g. load a hookish skill
   or run `plan_on`), confirm hook briefs appear in terminal but NOT in the
   WebUI chat log; normal briefs still appear; refresh page to confirm
   `/history` also omits them.

## Risks / notes

- **Signature churn is contained**: only 3 impl signatures + 1 interface
  change; all call sites are positional-compatible.
- **Wire format**: `synthetic` is omitted for normal messages, so old
  clients/serialized logs are unaffected.
- **Old transcripts**: entries without `synthetic` are unaffected (undefined
  is falsy) — no migration needed.
- The `log`/`warn`/`error` `agentIO` paths (non-brief) do NOT need the flag:
  they are already unlabeled and hidden by the 详细日志 toggle unless verbose.