# brief + recap-rewind: 契约

> 设计文档：`docs/loop/brief-and-recap-rewind.md`
> 本文是 brief/recap 回退的**契约表**：每条规则一句话，附实现位置与覆盖它的测试。

## 契约

| # | 规则 | 实现 | 测试 |
|---|------|------|------|
| C1 | **recap 失败不回滚**：只回答一条工具调用错误，triologue 其余部分逐字节不变 | `hook.ts` `fail()` | `H1 — a failed recap leaves no activity behind` |
| C2 | **recap 往返不是活动**：成功（anchor 往返留在最后）或失败都如此；`hasMessagesAfterBrief()` 按 `tool_name === 'recap'` 跳过这一对 | `triologue.ts` `hasMessagesAfterBrief()` | 同上 |
| C3 | **摘要下限**：空 / 纯空白 / `[RECAP] …` 协议行 / `(no summary)` / 短于 `MIN_RECAP_SUMMARY_CHARS` ⇒ 拒绝，不截断 | `hook.ts` `hasUsableSummary()` | `recap-rewind-empty-summary.test.ts` |
| C4 | **note 上限**：`recapNoteSize() > resultThreshold` ⇒ 拒绝，此时 store 未被触碰 | `triologue.ts` `recapNoteSize()` | `recap-rewind.test.ts` |
| C5 | **锚点身份 = brief 的 tool-call id**：`tool = brief && id = x`；不含数组下标、不含参数。它是 **compare-and-swap 令牌**（peek → 10-60s fork → 写回时确认「还是同一个 brief？」），**不是定位器** | `resolveAnchor(expectedBriefCallId)` | `M1 — anchor identity` |
| C6 | **id 复用取最近者**：畸形/恢复的历史复用 id 时，解析落在最新那次，旧锚点的 span 永不按猜测截断 | `currentAnchorIndex()` 自底向上扫 | `a reused call id collapses to the MOST RECENT anchor` |
| C7 | **单次解析**：`getLastBrief()` / `recapNoteSize()` / `rewindToLastBrief()` 共用一个私有快照 `{ index, resultIndex, call, anchorMessage, id }`，span 起点与截断点不可能不一致 | `resolveAnchor()` | `M2 — single anchor resolution` |
| C8 | **孤儿 brief 不是锚点**：brief 没有 tool 结果 ⇒ 没有写 note 的地方，截断会吊死 `tool_calls`；在付 fork 之前就拒绝 | `resolveAnchor()` → `resultIndex < 0` | `M2 — orphan brief` |
| C9 | **结果按 tool 名匹配**：call id 只在一轮内唯一，复用 id 不能把别的工具的结果认作 brief 的结果 | `findToolResultIndex(id, from, 'brief')` | `M2 — resolveAnchor matches the brief result by tool NAME` |
| C9b | **写回落在已解析的那一条**：两个 brief 共用 call id 时，note 写入 `resolveAnchor` 解析出的 `resultIndex`，而不是从 0 搜索到的第一条 | `rewriteToolResult(id, note, resultIndex)` | `M1 — a reused call id collapses to the MOST RECENT anchor`、`M2 — rewrites the resolved brief result` |
| C9c | **TOCTOU 令牌不是「找锚点」**：`anchorIdentity` 已删，但 id 仍作为 peek→fork→写回的 compare-and-swap 值（正常状态机在 await 期间不会推进一轮 LLM，所以它防的是 out-of-band 变更，不是常规竞态） | `resolveAnchor(expectedBriefCallId)` | `M1`（`id` 不变即通过、变了即拒绝） |
| C10 | **不写 `checkpoint_id`**：`MindmapPatchAction` 与其全部写入者都不再产出该键；旧 jsonl 多出的键读时被忽略，不做迁移 | `src/mindmap/types.ts` 等 | `patch-validation.test.ts` |

## 未覆盖（设计取舍，不修）

- **M3 — `synthetic` 只存在于内存**：transcript 写入/重建（`restoration.ts` 白名单）都保留该字段，当前不是漏洞；但任何新的重建路径若漏拷贝，infrastructure brief 会静默变成锚点。建议加一条 round-trip 不变量测试。
- **L2 — brief 对 teammate 可见、recap 只对 lead 可见**：有意取舍；teammate 侧 brief 只是状态上报，没有回退语义（见 `docs/tools/agent-tools.md`）。

## 验证

```
npm run typecheck:all   → 0 error
npx vitest run          → 218 files / 3114 tests passed（50 skipped）
npm run lint            → 0 error（4 个既有 prefer-template warning）
```
