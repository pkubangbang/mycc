# brief + recap-rewind: 潜在漏洞评审

> 评审对象：commit 5885fa8 / dc193a1 / 17c0350 / 6395ed5（v0.11.8）
> 设计文档：`docs/loop/brief-and-recap-rewind.md`
> 方法：静态阅读实现代码，逐条给出 file:line 证据 + 触发序列 + 后果 + 严重度。
> 未做动态复现——下文凡标注 **[未验证]** 的，都需要写一个针对性的测试才能定论。
>
> **修复轮（2026-10-21）**：H1 / H2 / M1 / M2 / L1 已修复，每项附「修复记录」小节（改动点 + 覆盖它的测试）。
> M3、L2 本轮**不在范围内**（用户明确排除），状态保持原样。

## 摘要

| # | 标题 | 严重度 | 状态 |
|---|------|--------|------|
| H1 | recap 失败后残留的 recap 回合会成为下一次可折叠的 span | 高 | **已修复**（失败 = 工具调用错误，不回滚、不留活动） |
| H2 | 摘要为空/极短时仍然截断，信息静默丢失 | 高（中） | **已修复**（§H2 修复记录） |
| M1 | `anchorIdentity` 是 位置+参数 的弱指纹，不是严格身份 | 中 | **已修复**（§M1 修复记录） |
| M2 | `getLastBrief().span` 与 `rewindToLastBrief` 各自重新解析锚点 | 中 | **已修复**（§M2 修复记录） |
| M3 | `synthetic` 是内存标记；重建 triologue 的路径需要逐一确认 | 中低 | 部分 **[未验证]** |
| L1 | mindmap patch 仍写遗留 `checkpoint_id: ''` | 低 | **已修复**（§L1 修复记录） |
| L2 | brief 对 child 可见、recap 只对 main 可见 | 低（设计取舍） | 已证据化 |

---

## H1 — recap 失败留下的回合，会被下一次 recap 折叠掉

**证据**

- 失败路径向 triologue 注册了整对回合，再返回 COLLECT（让模型重试）：
  `src/loop/states/hook.ts` 中锚点移动分支：
  ```ts
  const result = triologue.rewindToLastBrief(description, summary, anchor.id);
  if (!result) {
      ctx.core.brief('warn', 'recap', 'Anchor moved during summarization — nothing was collapsed.');
      return fail('Error: The last brief changed while the recap was summarizing, so nothing was collapsed. ...');
  }
  ```
  `fail()` 内部先 `triologue.agent(chat.assistantContent, chat.rawToolCalls)` 再 `triologue.tool('recap', message, call.id)`（`hook.ts` ~L97-103）。
- 锚点规则只有两条：非 synthetic + 其后至少一条消息（`src/loop/triologue.ts` `currentAnchorIndex()` / `hasMessagesAfterBrief()`）。
- 失败回合（assistant(recap) + tool(recap,错误)）落在某个 brief **之后**，因此它会成为那个 brief 的“活动”，使其成为锚点；而失败回合本身又是下次折叠区间的一部分。

**触发序列**

```
brief(A) → work → recap#1（fork 期间模型/系统插入 brief(B) 或用户 steering 产生新消息）→ 失败
  历史： … brief(A) → work → assistant(recap) → tool(recap, "last brief changed…")
新 brief(B) 已存在且其后有消息 ⇒ 锚点 = B
recap#2 → 折叠 B 之后的全部内容 ⇒ 用户的新工作 + 那次失败的 recap 回合一起消失
```
若 B 之后没有活动，则锚点仍是 B 且 `span.length === 0` → 直接拒绝；此时风险退化为“recap 永久失败直到有新活动”。

**后果**：用户在同一会话里刚产生的新输入/新工作可能被一次重试的 recap 静默折叠；note 里的 `**User's last query (context):**` 取自 `turn.lastUserQuery`，因此**用户最后一句话会出现在摘要里、但原始用户消息消失**——看起来“没丢东西”，实际丢了原文。

**建议修复方向**

1. （评审当时的建议，**未采用**）：给失败回合打不可折叠标记。最终方案见 §H1 修复记录：失败不产生特殊语义，只产生一条工具调用错误；锚点规则按 `tool_name === 'recap'` 跳过 recap 往返即可，不需要新字段。
2. 或者在 `handleRecapCall` 失败后把 `turn.nextBriefNudge` 清零并要求模型先 `brief`，让失败回合被一个新锚点隔开。
3. 最低成本：失败时在 tool 结果里明确要求“下一次 recap 前必须先 brief”，并让 `handleRecapCall` 检测“上一个 tool 结果是 recap 失败”时拒绝执行。

---

## H2 — 摘要为空也照样截断（没有下限检查）

**证据**

- `src/loop/recap-rewind.ts` `handleRecap()`：
  ```ts
  summary = summary || '(no summary)';
  ```
  以及对 ESC 的哨兵返回 `[RECAP] Cancelled: …`；对空历史返回 `[RECAP] No messages to summarize.`。
- `hook.ts` 只做**上限**检查：`noteSize > threshold` 才拒绝（`triologue.recapNoteSize(...)`），没有“摘要过短/为空”的下限。
- 截断与改写发生在 `Triologue.rewindToLastBrief()` 内（`src/loop/triologue.ts`），调用前无法回滚。

**触发序列**

```
brief(A) → 大量工作（span 很长）→ recap
fork 返回空串 / 仅空白 / "(no summary)"（缓存前缀巨大 + toolChoice:'none' 的模型退化、provider 截断、
  或模型只输出 JSON 壳）→ note ≈ "[RECAP] desc / Rewound past… / (no summary) / comment"
→ 截断生效 ⇒ 整段工作只剩一句 "(no summary)"
```
特别值得注意：fork 的输入是**截断前的完整前缀**（为命中 prompt cache），但真正需要概括的只是 `span`；当历史很大时，模型更容易忽略“只总结 brief 之后”的指令，输出空/套话。

**后果**：与 `abandon=true` 等价却没有用户知情——最坏情况的信息丢失路径，而且**不可恢复**（历史已删）。

**建议修复方向**

- 在 `hook.ts` 的 size 检查旁加**下限**检查：`summary.trim()` 长度 < N（如 80 字符）或命中 `'(no summary)'` 时拒绝并提示重试；宁可失败也不静默丢 span。
- 或者：若摘要过短，退化为“保留 span 的机械摘要”（列出 span 内的工具名与首行），保证信息密度下限。
- 可选：在 note 里显式带上 `span.length` 与 token 缩减比，让用户/模型能判断摘要是否可信（目前只有终端 brief 里有 token 数）。

---

## M1 — `anchorIdentity` 是弱指纹

**证据**：`src/loop/triologue.ts`
```ts
anchorIdentity(index, call) {
  … return `${index}:${call.function.name}:${args}`;
}
```
用于 TOCTOU 防护（`resolveAnchor(expectedAnchorId)`）。它绑定的是**数组下标 + 参数**，不是消息实体。

**触发序列**：锚点移动后又回到同一 `index`（例如 `wrapUp` 回滚把数组截短，再重放同样的 brief 调用），或两个 brief 的参数完全相同且恰好落在同一 index。此时 `expectedAnchorId` 会误判“锚点未变”。

**后果**：可能截断一个**没有**被摘要过的 span（低概率）。实际影响被两件事削弱：① `span` 已在 peek 时复制；② 失败即拒绝的路径存在。这更像“防御不是严格”的设计取舍，而非可复现缺陷 **[未验证：需要构造回滚+重放的测试]**。

**建议**：给每条消息一个单调递增的运行时序号（或在 `Message.synthetic` 旁加 `anchor_uid`），用 uid 替代 `index`。

---

## M2 — `span` 与 rewind 各自重新解析锚点

**证据**
- `getLastBrief()`（`triologue.ts` ~L1126）自己调用 `resolveAnchor()` 并切片 `sliceFrom(start)`；
- `rewindToLastBrief()`（~L1185）再调用一次 `resolveAnchor(expectedAnchorId)`，只复用 `expectedAnchorId` 做身份校验，不复用 `span`；
- `start` 的计算：`let start = index + 1; if (at(start)?.role === 'tool') start++;` —— 若锚点 brief 的 tool 结果缺失（orphan），`start` 不会跳过后半对，`span` 的首条就是本应被保留的“锚点自己的结果位置”。

**后果**：① 两次解析之间的新增消息（recap 期间的新 brief / steering）只能通过弱指纹发现（见 M1）；② orphan 情形下摘要区间与截断区间语义不一致。`rewindToLastBrief` 里 `resultIndex < 0` 会拒绝截断，所以不会截出错误历史，但会**浪费一次 10-60s 的 fork** 且失败信息对模型不友好。**[部分未验证]**

**建议**：把 `{index, call, span, uid}` 作为一个不可变快照返回给 handler，rewind 只接受该快照并校验 uid，不再重新扫描。

---

## M3 — `synthetic` 只存在于内存

**证据**
- `src/types.ts`：`Message.synthetic` 标注“in-memory only”；
- `MessageStore.getFullMessages()` 通过 `PROVIDER_MESSAGE_KEYS` allow-list 出站时剥离；
- 持久化：`transcript.ts` 的 `append()` 直接 `JSON.stringify(record)`，即 **synthetic 会落盘**（在 `new`/`merge` piece 里）；
- 重建：`restoration.ts` `readTriologue()` 白名单里**保留了** `raw.synthetic`（注释明确说明“dropping it here would silently turn a restored infrastructure brief back into a recap anchor”）。

**结论**：写读两条路径是一致的 → **当前不是漏洞**。但这是隐式契约：任何新的读取路径（新的 replay、导出、`/fork`、WebUI 侧重建）若忘记拷贝 `synthetic`，incidental brief 会静默变成锚点，且**没有任何断言会失败**。**[未验证：其它重建路径（如 slash/fork、reload）是否都走 readTriologue]**

**建议**：加一条不变量测试——“transcript round-trip 后 `briefIndices()` 必须与原数组一致”，并在 `PROVIDER_MESSAGE_KEYS` 旁注明持久化是刻意保留该字段。

---

## L1 — mindmap patch 仍写 `checkpoint_id: ''`

**证据**：`src/loop/recap-rewind.ts` 三处构造 patch 时都带 `checkpoint_id: '', // legacy field`；`src/mindmap/types.ts` 标注为遗留字段（“kept so old mindmap-patch.jsonl files still parse”）。

**问题**：不是功能漏洞，但每次 recap 都在 jsonl 里写入一个已无意义的检查点字段，且字段名会让后来者以为 checkpoint 仍然存在。文档“checkpoint 已删除”与产出物不一致。

**建议**：读取侧继续容忍，写入侧省略该键（老文件解析不受影响）。

## L2 — brief 对 teammate 可见、recap 只对 lead 可见

**证据**：`src/tools/brief.ts` `scope: ['main','child']`；`src/tools/recap.ts` `scope: ['main']`；`docs/tools/agent-tools.md` 记载 “brief description 不再教 recap（teammates 共享 schema 且无法调用 recap）”。

**问题**：这是**有意的**取舍（6395ed5 已修正描述），但残留语义风险：teammate 的 triologue（`TriologueLite`，teammate-worker.ts 注释明确“不需要 recap”）里 brief 不构成任何边界，而 lead 的 triologue 里同样的调用是锚点。同一个工具在不同主体下语义不同，新人阅读代码时容易误判。

**建议**：在 `docs/tools/agent-tools.md` 的 brief 条目里显式写一句“teammate 侧没有回退语义，brief 仅是状态上报”。

---

## 未覆盖 / 需要动态验证的点

1. H1：写一个 `hook-esc-recap` 风格的状态机测试——recap 期间注入新 brief，验证失败回合是否真的成为下次折叠区间。
2. H2：mock `forkChat` 返回 `''` / `'(no summary)'`，验证 span 是否被截断。
3. M2：构造 orphan brief（assistant 有 brief tool_call、无 tool 结果），观察 span 首元素与摘要 prompt。
4. 并发：recap fork 期间 teammate 的 mail/steering 是否可能插入 lead triologue（`turn.lastUserQuery` 是否会被改写），影响 note 里的 “[context]” 字段真实性。

---

# 修复记录（2026-10-21）

契约变化的一句话总结：**一次 recap 只有在「锚点唯一、摘要可用、note 未超限」三者同时成立时才会截断；任何拒绝都不会留下能被下一次 recap 折叠的“假活动”。**

## H1 — 失败的 recap 不回滚、不留活动

**设计结论（先想清楚，再改代码）**：recap 只有两种结局——

- **成功**：span 被截断，summary 写入**上一个 brief 的工具结果**（`rewindToLastBrief`，既有行为）。
- **失败**：**什么也不回滚**，只生成一条普通的工具调用错误结果（`tool('recap', error)`），triologue 其余部分与失败前逐字节相同。

失败**不需要**任何消息级标记。锚点规则只需要知道一件事：**recap 工具永远不产生活动**——成功时它把 anchor 往返留在最后（规则 3 天然满足），失败时它只回答了一条错误。`hasMessagesAfterBrief()` 因此按 `tool_name === 'recap'` 跳过这一对往返，同一规则覆盖两种结局。

**BEFORE / AFTER**

```
BEFORE（第一版修复，错误）: Message.recap_failed 标记 + tool() 第四参数
                          → 把 recap 的控制流状态塞进通用消息模型（层错位）

BEFORE（原始缺陷）:        brief(A) → work → recap(failed) ⇒ A 被激活，
                          下次 recap 折叠掉用户未服务的查询

AFTER:                     brief(A) → work → recap(failed) ⇒ getLastBrief() === null，
                          rewindToLastBrief() === null；只有真实工具/用户消息才激活 A
```

**改动**

- `src/loop/triologue.ts`：`hasMessagesAfterBrief()` 跳过 recap 往返（assistant 调用 + 它自己的结果，不论成功或报错）；`tool()` 签名回到 `(name, result, toolCallId?)`。
- `src/loop/states/hook.ts`：`fail()` 与 ESC 取消分支只注册工具调用错误结果，无标记。
- 未修改 `Message`（无新字段）。

**测试**：`src/tests/loop/recap-rewind.test.ts` → `H1 — a failed recap leaves no activity behind`（5 例：孤立 brief + 失败非锚点；失败不移动锚点；失败不截断且不改写 anchor 结果；失败后真实活动照常激活；成功 recap 仍把 note 写进 brief 结果、不新增消息）。

## H2 — 摘要下限

**改动**

- `src/loop/recap-rewind.ts`：删掉 `summary = summary || '(no summary)'` 占位符，改为 `summary.trim()`；空摘要**原样**返回给调用方。
- `src/loop/states/hook.ts`：新增 `hasUsableSummary()` + `MIN_RECAP_SUMMARY_CHARS = 40`，在两处 fork 之后、size 上限检查之前做下限检查（拒绝空串、纯空白、`[RECAP] …` 协议行、`(no summary)`、低于下限的残句），拒绝时不截断、返回 COLLECT 并让模型重试。
- 下限与上限现在是**双向**的：`noteSize > threshold` 拒绝（原有），`!hasUsableSummary` 拒绝（新增）；两者都在 `rewindToLastBrief` 之前，store 未被触碰。

**BEFORE / AFTER**

```
BEFORE: fork 返回 '' → '(no summary)' → 通过 size 检查 → 截断 span（知识丢失，note 只剩标题）
AFTER:  fork 返回 '' → hasUsableSummary=false → 拒绝，span 留在 context
```

**测试**：`src/tests/loop/states/recap-rewind-empty-summary.test.ts`（5 例：空串不替换、纯空白无正文、trim、ESC 哨兵不变、空历史短路）。

## M1 — 锚点身份

**改动**：`anchorIdentity(call)` 由 `${index}:${name}:${args}` 改为 `${call.id}:${name}:${args}`——去掉数组下标（rollback/replay 后同一位置可能换了别的 brief），保留参数作为判别器（call id 只在一轮内唯一，重放可能复用）。

**测试**：`recap-rewind.test.ts` → `M1 — anchor identity`（不同 index 得到同一 id；同 call id 不同参数得到不同 id）。

## M2 — 单次解析

**改动**：`resolveAnchor()` 现在返回 `{ index, resultIndex, call, anchorMessage, id }` 的完整快照：

- `resultIndex` 用 `findToolResultIndex(call.id, index + 1)`（带 `fromIndex`，不会绑定到 span 里更早的同名结果）；
- **孤儿 brief**（没有 tool 结果）直接不是锚点 → `getLastBrief()` 返回 null，调用方在**付两次 fork 之前**就拒绝；
- `getLastBrief().span` 从 `resultIndex + 1` 起切（以前是“下一条是 tool 就跳一条”，会吞掉一条无关结果）；
- `rewindToLastBrief()` 直接消费快照里的 `resultIndex`，不再自己从 0 重新扫描。

**测试**：`recap-rewind.test.ts` → `M2 — single anchor resolution`（孤儿 brief 非锚点；span 不吞无关 tool 结果；截断点与 span 起点一致）。

## L1 — 停止写 `checkpoint_id`

**改动**：字段**彻底删除**——`MindmapPatchAction` 不再声明 `checkpoint_id`（`src/mindmap/types.ts`），`src/loop/recap-rewind.ts` 与 `src/mindmap/patch-jsonl.ts` 共 6 处不再写，`src/tests/mindmap/patch-validation.test.ts` 的 12 个夹具也一并去掉。

**不追求旧 jsonl 兼容**（按用户指示）：读路径是 `JSON.parse` 后按类型断言使用，旧文件里多出的 `checkpoint_id` 只会被忽略、不会报错，因此**不需要**任何迁移代码；但也不再“特意保留”该字段。新写入的 patch 不再含此键。

**验证**：`npx vitest run src/tests/mindmap`（含 `patch-validation`、`patch-jsonl` 相关用例）全绿；`npm run typecheck:all` 通过。

---

## 验证汇总

```
npm run typecheck:all   → 通过（0 error）
npx vitest run          → 218 files / 3097 tests passed（50 skipped）
npm run lint            → 0 error（3 个 warning 为既有：evaluator.ts、sensitive-paths.ts）
```
