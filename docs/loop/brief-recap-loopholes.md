# brief + auto-recap: 契约

> 设计文档：`docs/loop/brief-and-recap-rewind.md`
> 计划：`docs/loop/auto-recap-plan.md`
> 本文是 brief/自动回退（auto-recap）的**契约表**：每条规则一句话，附实现位置与覆盖它的测试。

> 背景：`recap` META-TOOL 已删除。回退由 HOOK 阶段 4a 的 recap-signal
> **观察者**决定，不由模型决定。旧 `recap` 往返不计活动的特例（原 C2）随之删除；
> 旧 transcript 不在兼容范围内。

## 契约

| # | 规则 | 实现 | 测试 |
|---|------|------|------|
| C1 | **信号/分叉失败不回滚**：`failed` 或摘要为空时只发一条 `auto_recap` 事件（+ 用户提示），triologue 逐字节不变 | `hook.ts` `handleAutoRecap()` | `hook-esc-and-brief-isolation.test.ts` |
| C3 | **摘要下限**：空 / 纯空白 / `[RECAP] …` 协议行 / `(no summary)` / 短于 `MIN_RECAP_SUMMARY_CHARS` ⇒ 保留 span，不截断 | `hook.ts` `handleAutoRecap()` + `recap-rewind.ts` `handleRecapForks()` | `recap-rewind.test.ts`、`recap-rewind-spinner.test.ts` |
| C4 | **note 上限**：`recapNoteSize() > resultThreshold` ⇒ 拒绝，此时 store 未被触碰 | `triologue.ts` `recapNoteSize()` | `recap-rewind.test.ts` |
| C5 | **锚点身份 = brief 的 tool-call id**：`tool = brief && id = x`；不含数组下标、不含参数。它是 **compare-and-swap 令牌**（peek → fork → 写回时确认「还是同一个 brief？」），**不是定位器** | `resolveAnchor(expectedBriefCallId)` | `M1 — anchor identity` |
| C6 | **id 复用取最近者**：畸形/恢复的历史复用 id 时，解析落在最新那次，旧锚点的 span 永不按猜测截断 | `currentAnchorIndex()` 自底向上扫 | `a reused call id collapses to the MOST RECENT anchor` |
| C7 | **单次解析**：`getLastBrief()` / `recapNoteSize()` / `rewindToLastBrief()` 共用一个私有快照 `{ index, resultIndex, call, anchorMessage, id }`，span 起点与截断点不可能不一致 | `resolveAnchor()` | `M2 — single anchor resolution` |
| C8 | **孤儿 brief 不是锚点**：brief 没有 tool 结果 ⇒ 没有写 note 的地方，截断会吊死 `tool_calls`；在付 fork 之前就拒绝 | `resolveAnchor()` → `resultIndex < 0` | `M2 — orphan brief` |
| C9 | **结果按 tool 名匹配**：call id 只在一轮内唯一，复用 id 不能把别的工具的结果认作 brief 的结果 | `findToolResultIndex(id, from, 'brief')` | `M2 — resolveAnchor matches the brief result by tool NAME` |
| C9b | **写回落在已解析的那一条**：两个 brief 共用 call id 时，note 写入 `resolveAnchor` 解析出的 `resultIndex`，而不是从 0 搜索到的第一条 | `rewriteToolResult(id, note, resultIndex)` | `M1 — a reused call id collapses to the MOST RECENT anchor`、`M2 — rewrites the resolved brief result` |
| C9c | **TOCTOU 令牌不是「找锚点」**：id 仍是 peek→fork→写回的 compare-and-swap 值（正常状态机在 await 期间不会推进一轮 LLM，所以它防的是 out-of-band 变更，不是常规竞态）；CAS 失败 ⇒ 不折叠 | `resolveAnchor(expectedBriefCallId)` | `M1`（`id` 不变即通过、变了即拒绝） |
| C10 | **不写 `checkpoint_id`**：`MindmapPatchAction` 与其全部写入者都不再产出该键；旧 jsonl 多出的键读时被忽略，不做迁移 | `src/mindmap/types.ts` 等 | `patch-validation.test.ts` |
| C11 | **信号判定是外部权威**：折叠与否由 recap-signal（只读 brief 栈 + token 用量）决定；模型永远看不到 hash、`recap(...)`、`[<hash>] ANCHOR` 或 `· open:` | `recap-signal.ts` `evaluateRecapSignal()` | `recap-signal.test.ts`（待补） |
| C12 | **未知目标降级为 skip**：`recap: true` 但 `target_brief` 缺失/无效/不在候选表 ⇒ `skip`，绝不回退到默认目标 | `recap-signal.ts` `parseVerdict()` | `recap-signal.test.ts`（待补） |
| C13 | **只在 brief 回合触发，且在该 brief 注册之前**：当前 brief 因此成为新 chunk 的首条消息；`blockedCalls`、neglected 模式、`compactRequested`/`deferredCompact`、空候选表都折叠 0 次 | `hook.ts` `handleAutoRecap()` | `hook-esc-and-brief-isolation.test.ts` |
| C14 | **lead only + 可关闭**：`scope !== 'main'` 或 `--no-recap` / `MYCC_NO_RECAP=1` 时整段短路 | `hook.ts` `handleAutoRecap()` + `config.ts` `shouldNoRecap()` | `hook-brief-isolation.test.ts` |
| C15 | **一次折叠只留一条审计**：可见 `[recap]` 块 + 恰好一条 `{kind:'steer', role:'user'}` JSONL 记录；信号/分叉期间不追加任何记录 | `hook.ts` `handleAutoRecap()` + `triologue.submitUser(..., 'steer')` | `transcript-recap-audit.test.ts`（待补） |
| C16 | **折叠后同回合不再触发 plan-scope 反思**：`chat.autoRecapFolded = true` 让 `handlePlanScopeBrief` 返回 null | `hook.ts` `handlePlanScopeBrief()` | `hook-plan-scope.test.ts` |
| C17 | **brief 必须独占一个回合**：与其它工具同批 ⇒ 整回合被拒（`Brief must be called alone.`）。理由收窄为：loop 的切片算术（`resolveAnchor` → `resultIndex + 1` → `sliceFrom`）需要干净的 brief 边界，且 4a 依赖「当前 brief 尚未注册」 | `src/loop/triologue/brief.ts` `validateBriefIsolation()` | `triologue-brief-isolation.test.ts` |

## 未覆盖（设计取舍，不修）

- **M3 — `synthetic` 只存在于内存**：transcript 写入/重建（`restoration.ts` 白名单）都保留该字段，当前不是漏洞；但任何新的重建路径若漏拷贝，infrastructure brief 会静默变成锚点。建议加一条 round-trip 不变量测试。
- **L2 — brief 对 teammate 可见、折叠只对 lead 可见**：有意取舍；teammate 侧 brief 只是状态上报，没有回退语义（见 `docs/tools/agent-tools.md`）。
- **反震荡**：不设额外守卫。一次成功折叠会消费其目标（锚点往返重新留在末尾），下一次信号只能看到此后真实工作打开的 span。

## 验证

```
npm run typecheck:all   → 0 error
npx vitest run          → 256 files passed
npm run lint            → 0 error（4 个既有 prefer-template warning）
```
