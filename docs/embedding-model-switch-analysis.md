# 更换 RAG 嵌入模型影响分析：nomic-embed-text → embeddinggemma

> 生成时间：2026-07-10
> 研究团队：wiki-researcher、skill-researcher、slash-cmd-researcher、consistency-researcher

---

## 前置事实

| 属性 | nomic-embed-text | embeddinggemma |
|------|-----------------|----------------|
| 输出维度 | 768 | **768**（默认，支持 MRL 截断至 512/256/128） |
| 是否需要 prompt 前缀 | 否 | **是** — query: `task: search result \| query: {text}`，document: `title: {title} \| text: {text}` |
| 模型配置方式 | `OLLAMA_EMBEDDING_MODEL` 环境变量 | 同上 |
| 模型名缓存时机 | 模块加载时（`const`） | 同上，需重启进程才能生效 |

---

## 一、维度兼容性：✅ 无需改码（默认配置下）

- `wiki.ts:70` 硬编码了 `new Array(768).fill(0)` 作为 LanceDB 表的 schema 占位记录。embeddinggemma 默认输出 768 维，与 nomic-embed-text 完全一致，**不产生 schema 冲突**。
- `cosineSimilarity()` 在 `wiki.ts` 和 `request-embedding.ts` 中都有 `a.length !== b.length → return 0` 的守卫，维度一致时不会触发。
- **风险点**：如果用户配置了 embeddinggemma 的 MRL 截断（512/256/128），则 768 维的 schema 占位记录会与新嵌入向量维度不匹配，LanceDB 的 `table.add()` 可能报错。**已决策**：维度不再可配置，nomic-embed-text 和 embeddinggemma 均硬编码为 768（两者默认输出维度恰好一致）。MRL 截断场景不支持。

---

## 二、Prompt 前缀：❌ 核心代码缺口（已验证）

### 验证结论

**Ollama 的 `/api/embed` 端点不会自动应用 prompt 前缀或 Modelfile 模板。调用方必须手动添加前缀。代码改动是必需的。**

`getEmbedding()` 当前实现（`ollama-embedding.ts`）直接将原始文本传给 Ollama，**不添加任何前缀**：

```typescript
export async function getEmbedding(text: string): Promise<number[]> {
  const response = await ollama.embed({ model: EMBEDDING_MODEL, input: text });
  return response.embeddings[0];
}
```

embeddinggemma 训练时使用了 task-specific 前缀，不加前缀会导致嵌入向量落入次优向量空间区域，**搜索质量显著下降**。

### 验证证据

| 证据来源 | 内容 |
|---------|------|
| Ollama OpenAPI spec (`/api/embed`) | API schema 无 `template` 或 `raw` 参数（对比 `/api/generate` 有这两个参数），直接将 input 传给模型嵌入层，零格式化 |
| Ollama PR #759 (2023-10) | 明确移除/废弃了 Modelfile 中的 EMBED 命令，使用 EMBED 会报 `Error: deprecated command: EMBED` |
| GitHub issue #12191 (ollama/ollama) | 用户报告 embeddinggemma 通过 Ollama `/api/embed` 不加前缀时产生"completely non-sense results"，而 nomic-embed-text/bge-m3/all-minilm 都正常 |
| Google Gemma 官方 Cookbook | `RAG_with_EmbeddingGemma.ipynb` 中显式调用 `model.encode(query, prompt_name="Retrieval-query")` 应用 `"task: search result \| query: "` 前缀 |
| 第三方参考实现 (dnvriend/vector-rag-tool) | 显式实现 `format_query()` 和 `format_document()` 在调用 `ollama.embed()` 前添加前缀 |

### 受影响的 5 个调用点

| 调用位置 | 用途 | 需要的前缀类型 |
|---------|------|--------------|
| `wiki.ts:187` (prepare) | 文档入库前嵌入 | document 前缀 |
| `wiki.ts:238` (put) | 文档存储嵌入 | document 前缀 |
| `wiki.ts:283` (get) | 查询嵌入 | query 前缀 |
| `wiki.ts:610` (rebuild) | 重建时重新嵌入 | document 前缀 |
| `request-embedding.ts:50` | 循环检测（对称比较） | 可统一用 document 前缀或不改 |

### 需要改码的位置

1. `src/engine/ollama-embedding.ts` — 增加 query/document 模式参数或拆分为两个函数
2. `src/context/parent/wiki.ts` — prepare/put/rebuild 传 document 前缀，get 传 query 前缀
3. `src/context/shared/loader.ts` — `indexSkillToWiki()` 的 skill 内容嵌入也需 document 前缀

---

## 三、数据一致性：⚠️ 无防护，静默失败

### 核心风险

LanceDB 不存储模型名或维度元数据，新旧模型向量可共存但语义不兼容。

- 换模型后如果不重建，`wiki.get()` 的查询用 embeddinggemma 嵌入，但表中有 nomic 旧向量 → 余弦相似度无意义 → 搜索结果静默变垃圾，**无任何报错**。
- `checkDuplicate()`（阈值 0.95）跨模型比较同理失效，无法检测真实重复。
- `RequestEmbeddingTracker`（循环检测）是内存滚动缓冲区（max 20 条，会话隔离），**不受影响**。

### WAL 恢复路径

WAL 存储原始文本（非嵌入向量），`/wiki rebuild` 会 `delete('true')` 清空表后用当前模型重新嵌入所有 WAL 条目，产生一致表。

WAL 文件位置：`.mycc/wiki/logs/{YYYY-MM-DD}.wal`，JSON-lines 格式，每天一个文件。

### 所有 getEmbedding() 消费者及其脆弱性

| 消费者 | 文件 | 是否持久化 | 脆弱性 |
|--------|------|-----------|--------|
| RequestEmbeddingTracker | `src/loop/request-embedding.ts` | 否（内存滚动缓冲，会话隔离） | **低** — 每会话重置 |
| WikiManager.prepare() | `wiki.ts:187` | 生成嵌入用于去重检查 | **高** — 跨模型比较无意义 |
| WikiManager.put() | `wiki.ts:238` | 存入 LanceDB + 追加 WAL | **高** — 插入新模型向量到含旧向量表 |
| WikiManager.get() | `wiki.ts:283` | 查询嵌入并比较 | **严重** — 静默返回垃圾结果 |
| WikiManager.rebuild() | `wiki.ts:610` | 重读 WAL 重新嵌入 | **安全** — 清表后一致重建 |
| skill_load → indexSkillToWiki() | `loader.ts:723` | 间接调用 prepare/put | **高** — 同 prepare/put |
| skill_search → wiki.get() | `skill_search.ts:52` | 间接查询 | **严重** — 混合模型时静默失败 |

---

## 四、Slash 命令与重建路径

### 可用命令

| 命令 | 功能 |
|------|------|
| `/wiki rebuild` | ✅ 从所有 WAL 文件重新嵌入，清空表后重建。**核心恢复命令** |
| `/skills build` | 重新加载 skill 文件并调用 `indexAllSkillsToWiki()` |
| `/wiki delete <hash>` | 按 hash 删除文档 |
| `/wiki domains` | 列出/添加/删除域 |
| `/wiki export/import` | 导出/导入 wiki 条目 |
| `/wiki` / `/wiki edit [date]` | 查看/编辑 WAL 文件 |

**无 `/wiki clear` 或 `/wiki reset`** — 没有命令能 drop LanceDB 表。若需处理维度变化，需手动删除 LanceDB 目录。

### `/wiki rebuild` 实现细节

1. `this.table.delete('true')` — 删除所有行（保留表 schema，不 drop 表）
2. 按文件名（日期）排序读取所有 `*.wal` 文件
3. 对每个 `approved` 且非 `deleted` 的条目，调用 `getEmbedding(entry.document.content)` 重新嵌入
4. 通过 `this.table.add()` 写入 LanceDB
5. 返回 `{ success, documentsProcessed, errors }`

### `/skills build` 的 stale-embedding 陷阱

`indexSkillToWiki()` 有基于内容去重的优化 — 如果 `existingResults[0].document.content === content`，则跳过重新嵌入。换模型后 skill 内容未变，但嵌入向量是旧模型的。**这意味着 `/skills build` 单独执行可能不会更新嵌入向量**。

### `/skills build` 写 WAL ✅ — `/wiki rebuild` 可恢复 skill 嵌入

**已验证：`/skills build` 会写 WAL。** 完整调用链：

1. `/skills build` → `loader.indexAllSkillsToWiki(ctx.wiki)` (`skills.ts:28-30`)
2. → `indexSkillToWiki()` → `wiki.prepare(document, true)` → `wiki.put(hash, document)` (`loader.ts:751-753`)
3. → `WikiManager.put()` → `this.appendWAL(...)` (`wiki.ts:260-263`)
4. → 写入 `.mycc/wiki/logs/{YYYY-MM-DD}.wal`

**结论：skill 条目存储在 WAL 中（domain='skills'），`/wiki rebuild` 会重新嵌入所有 WAL 条目，包括 skill 条目。因此换模型后只需运行 `/wiki rebuild` 即可恢复全部嵌入（wiki 文档 + skill 索引），无需单独运行 `/skills build`。**

---

## 五、Skill 模块特殊关注

### 嵌入内容

skill 的嵌入内容**不是全文**，而是紧凑的元数据字符串：

```
Scope: {scope}
Name: {skill.name}
Description: {skill.description}
Keywords: {kw1, kw2, ...}
```

### 搜索路径

- `skill_search.ts` 不直接调用 `getEmbedding()`，委托给 `wiki.get()`
- 搜索查询会加前缀 `"a skill to satisfy: ${search}"`，再传给 `wiki.get()`
- `wiki.get()` 对该字符串调用 `getEmbedding()`，与 LanceDB 中 "skills" 域的向量做余弦相似度比较

### 阈值

- `SKILL_MATCH_THRESHOLD` 默认 0.5，可通过 `--skill-match-threshold` 配置
- `DUPLICATE_THRESHOLD = 0.95`（wiki 通用去重）
- 换模型后相似度分布不同，可能需要调低至 0.3-0.4

### 双重嵌入低效

`wiki.prepare()` 和 `wiki.put()` 都对同一内容调用 `getEmbedding()`（两次嵌入），不是正确性问题但是 API 调用浪费。

---

## 六、测试影响

- `src/tests/loop/request-embedding.test.ts` 中硬编码 `dimension = 768` 和 `new Array(768).fill(0)`
- 测试完全 mock `getEmbedding`，不调用真实模型 → **不会 break**
- 但语义上过时（若未来支持 MRL 维度）

---

## 七、设置向导

- `src/setup/prompts.ts:59` 默认值为 `'nomic-embed-text'`
- 向导接受任意模型名（自由文本输入），用户可手动输入 `embeddinggemma`，**无需改码即可选择**
- 但默认值和帮助文本未提及 embeddinggemma 及其前缀要求

---

## 影响矩阵

| 影响维度 | 严重度 | 是否需要改码 | 说明 |
|---------|--------|------------|------|
| 维度兼容（768 vs 768） | ✅ 无 | 否（已硬编码） | nomic-embed-text 和 embeddinggemma 均硬编码 768，不再可配置 |
| Prompt 前缀 | ❌ **高** | **是** | `ollama-embedding.ts` + `wiki.ts` 4处 + `loader.ts` |
| 数据迁移（旧向量不兼容） | ⚠️ **高** | 否（命令即可） | 必须运行 `/wiki rebuild` |
| `/skills build` 陷阱 | ⚠️ 中 | 建议改进 | 内容去重导致跳过重嵌入 |
| 混合向量静默失败 | ⚠️ 中 | 建议加防护 | 无模型元数据存储，建议加 `model` 列 |
| 测试 | ✅ 低 | 否 | mock 模式下不受影响 |
| 设置向导默认值 | ✅ 低 | 可选 | 建议更新帮助文本 |
| 运行时切换模型 | ✅ 低 | 否 | 需重启进程 |

---

## 建议的操作步骤（换模型后）

1. `ollama pull embeddinggemma`
2. 修改 `.mycc/.env` 中 `OLLAMA_EMBEDDING_MODEL=embeddinggemma`
3. 重启 mycc 进程（`EMBEDDING_MODEL` 是模块加载时的 `const`）
4. 运行 `/wiki rebuild`（核心步骤 — 从 WAL 重新嵌入所有文档**及 skill 索引**，一步到位）
5. 观察 `SKILL_MATCH_THRESHOLD`（默认 0.5），可能需要调低至 0.3-0.4

---

## 可选的代码改进（提升 embeddinggemma 支持质量）

1. **`ollama-embedding.ts`**：增加 `getEmbedding(text, mode: 'query'|'document')` 模式参数，按 embeddinggemma 规范添加前缀
2. **`wiki.ts:70`**：~~将 `768` 改为可配置维度（`OLLAMA_EMBEDDING_DIM`）~~ **已决策**：维度硬编码为 768，不再可配置（rag-provider 物化后，指定模型即指定维度）
3. **LanceDB schema**：增加 `model` 列存储嵌入模型名，启动时检测模型不一致并警告
4. **`/wiki reset` 命令**：新增 drop+recreate 表的命令，处理维度变化场景
5. **`indexSkillToWiki` 去重逻辑**：增加 force-rebuild 选项，跳过内容去重检查

---

## 研究文件清单

| 文件 | 角色 | 关键发现 |
|------|------|---------|
| `src/context/parent/wiki.ts` (718行) | wiki-researcher | LanceDB schema 硬编码 768、getEmbedding 调用点、cosineSimilarity、rebuild |
| `src/engine/ollama-embedding.ts` (32行) | wiki-researcher | 无前缀的原始嵌入调用、模块加载时缓存模型名 |
| `src/tools/skill_search.ts` | skill-researcher | 语义搜索委托 wiki.get()，不直接调用嵌入 |
| `src/tools/skill_load.ts` | skill-researcher | 加载时触发 indexSkillToWiki |
| `src/context/shared/loader.ts` | skill-researcher | indexSkillToWiki 去重陷阱、嵌入内容为元数据 |
| `src/loop/request-embedding.ts` | consistency-researcher | 内存滚动缓冲，会话隔离，不受影响 |
| `src/slashes/wiki.ts` | slash-cmd-researcher | /wiki rebuild 从 WAL 重建 |
| `src/slashes/skills.ts` | slash-cmd-researcher | /skills build 重新索引 |
| `src/setup/prompts.ts` | slash-cmd-researcher | 默认 nomic-embed-text |
| `src/setup/models.ts` | slash-cmd-researcher | ollama pull 嵌入模型 |
| `src/tests/loop/request-embedding.test.ts` | consistency-researcher | 硬编码 768，mock 模式 |
| `src/config.ts` | skill-researcher | SKILL_MATCH_THRESHOLD 默认 0.5 |

---

## 外部参考

- embeddinggemma model card (Google AI for Developers) — 确认 768 维默认 + MRL + prompt 前缀要求
- Ollama embeddings documentation — 确认 embeddinggemma 为推荐模型之一

---

# RAG Provider 兼容层设计方案

> 目标：仿照 api-provider 模式，建立 rag-provider 兼容层，支持 nomic-embed-text 和 embeddinggemma 两种嵌入模型，并通过 namespace 将不同模型的向量分开存放。

## A. 现有 api-provider 模式（参考）

```
src/engine/
├── chat-provider.ts      ← 门面（facade），根据 API_PROVIDER 选择 active provider
├── ollama.ts             ← Ollama 实现
├── deepseek.ts           ← DeepSeek 实现
└── ollama-embedding.ts   ← 嵌入模块（当前硬编码走 Ollama，无 provider 抽象）
```

**核心模式**：
1. `config.ts` 的 `getApiProvider()` 返回 `'ollama' | 'deepseek'`（`config.ts:288`）
2. `chat-provider.ts` 静态导入两个模块，三元选择 active：`const active = getApiProvider() === 'deepseek' ? deepseekMod : ollamaMod`（`chat-provider.ts:11`）
3. 重导出 active 的函数：`export const retryChat = active.retryChat`（`chat-provider.ts:14-24`）
4. Embedding 始终走 Ollama：`export { getEmbedding } from './ollama-embedding.js'`（`chat-provider.ts:22`）
5. 无 TypeScript 接口 — 使用 duck-typed 模块导出，签名相同
6. 共享工具放在 `chat-helpers.ts`

## B. RAG Provider 设计

### B.1 配置层（config.ts）

新增 `getRagProvider()` — 按 `OLLAMA_EMBEDDING_MODEL` 自动推断 provider：

```typescript
export type RagProvider = 'nomic' | 'embeddinggemma';

export function getRagProvider(): RagProvider {
  const model = process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text';
  if (model.startsWith('embeddinggemma')) return 'embeddinggemma';
  return 'nomic';
}
```

不需要额外 CLI flag — 复用现有 `--ollama-embedding-model` 即可自动推断。

### B.2 门面层（rag-provider.ts）

新增 `src/engine/rag-provider.ts`，完全仿照 `chat-provider.ts` 模式：

```typescript
import { getRagProvider } from '../config.js';
import * as nomicMod from './rag-nomic.js';
import * as gemmaMod from './rag-embeddinggemma.js';

export type EmbedMode = 'query' | 'document';

const active = getRagProvider() === 'embeddinggemma' ? gemmaMod : nomicMod;

export const getEmbedding = active.getEmbedding;
export const EMBEDDING_MODEL = active.EMBEDDING_MODEL;
export const EMBEDDING_DIM = active.EMBEDDING_DIM;
export const NAMESPACE = active.NAMESPACE;
```

### B.3 Provider 实现

#### nomic（`src/engine/rag-nomic.ts`）

```typescript
export const EMBEDDING_MODEL = process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text';
export const EMBEDDING_DIM = 768;
export const NAMESPACE = 'nomic';

export async function getEmbedding(text: string, _mode?: EmbedMode): Promise<number[]> {
  // nomic 不需要前缀，mode 参数被忽略
  const response = await ollama.embed({ model: EMBEDDING_MODEL, input: text });
  return response.embeddings[0];
}
```

#### embeddinggemma（`src/engine/rag-embeddinggemma.ts`）

```typescript
export const EMBEDDING_MODEL = process.env.OLLAMA_EMBEDDING_MODEL || 'embeddinggemma';
export const EMBEDDING_DIM = 768;
export const NAMESPACE = 'embeddinggemma';

export async function getEmbedding(text: string, mode: EmbedMode = 'document'): Promise<number[]> {
  const input = mode === 'query'
    ? `task: search result | query: ${text}`
    : `title: none | text: ${text}`;
  const response = await ollama.embed({ model: EMBEDDING_MODEL, input });
  return response.embeddings[0];
}
```

### B.4 Namespace 向量隔离（LanceDB 表名隔离）

**方案：按模型使用不同 LanceDB 表名**（consistency-researcher 推荐 Option A）

- **当前**：`tableName = 'wiki'`（`wiki.ts:40`）
- **改造后**：`tableName = \`wiki_${NAMESPACE}\``（如 `wiki_nomic`、`wiki_embeddinggemma`）

**优势**：
- 物理隔离 — 不同模型向量不可能混淆
- 旧表保留在磁盘上，切回旧模型可直接使用
- `cosineSimilarity()` 自然只比较同模型向量
- 仅需一行改动

**WAL 不隔离**：WAL 存储原始文本（模型无关）。在 `WALEntry` 中增加可选 `namespace` 字段，`rebuild()` 时只处理当前 namespace 的条目。无 namespace 字段的旧条目按当前 provider 处理（首次切换时重建全部历史数据）。

### B.5 wiki.ts 改造点

| 位置 | 当前代码 | 改造后 |
|------|---------|--------|
| import | `from '../../engine/ollama-embedding.js'` | `from '../../engine/rag-provider.js'` |
| 表名 (`:40`) | `tableName = 'wiki'` | `tableName = \`wiki_${NAMESPACE}\`` |
| schema 维度 (`:70`) | `new Array(768).fill(0)` | `new Array(EMBEDDING_DIM).fill(0)` |
| prepare() (`:187`) | `getEmbedding(document.content)` | `getEmbedding(document.content, 'document')` |
| put() (`:238`) | `getEmbedding(document.content)` | `getEmbedding(document.content, 'document')` |
| get() (`:283`) | `getEmbedding(query)` | `getEmbedding(query, 'query')` |
| rebuild() (`:610`) | `getEmbedding(entry.document.content)` | `getEmbedding(entry.document.content, 'document')` |
| appendWAL() | 无 namespace | `entry.namespace = NAMESPACE` |
| rebuild() 过滤 | 无过滤 | `if (entry.namespace && entry.namespace !== NAMESPACE) continue;` |

### B.6 其他文件改造

| 文件 | 改造 |
|------|------|
| `src/loop/request-embedding.ts` | import 改为 `rag-provider.js`，`getEmbedding(text, 'document')` |
| `src/engine/chat-provider.ts` (`:22`) | `export { getEmbedding } from './rag-provider.js'` |
| `src/types.ts` (`WALEntry`) | 增加 `namespace?: string` 字段 |
| `src/setup/prompts.ts` (`:59`) | 嵌入模型帮助文本增加 embeddinggemma 选项 |
| `src/tools/skill_search.ts` | **无改动** — 通过 wiki.get() 间接调用 |
| `src/context/shared/loader.ts` | **无改动** — 通过 wiki.prepare/put 间接调用 |

### B.7 迁移策略

1. 旧的 `wiki` 表保留在 LanceDB 中但不被使用
2. 新建 `wiki_embeddinggemma` 表，初始为空
3. 用户运行 `/wiki rebuild` 从 WAL 重新嵌入所有条目到新表
4. WAL 中无 `namespace` 字段的旧条目在 rebuild 时按当前 provider 处理

### B.8 切换模型的用户操作

1. `ollama pull embeddinggemma`
2. 修改 `.mycc/.env` 中 `OLLAMA_EMBEDDING_MODEL=embeddinggemma`
3. 重启 mycc 进程
4. 运行 `/wiki rebuild`

## C. 文件变更清单

| 文件 | 操作 |
|------|------|
| `src/engine/rag-provider.ts` | **新建** — 门面 |
| `src/engine/rag-nomic.ts` | **新建** — nomic 实现 |
| `src/engine/rag-embeddinggemma.ts` | **新建** — embeddinggemma 实现（带前缀） |
| `src/engine/ollama-embedding.ts` | **删除** — 被 rag-provider 替代 |
| `src/config.ts` | **编辑** — 新增 `getRagProvider()`, `RagProvider` 类型 |
| `src/context/parent/wiki.ts` | **编辑** — namespace 表名 + 动态维度 + mode 参数 |
| `src/loop/request-embedding.ts` | **编辑** — import 改为 rag-provider |
| `src/engine/chat-provider.ts` | **编辑** — embedding 重导出改为 rag-provider |
| `src/types.ts` | **编辑** — WALEntry 增加 `namespace?` 字段 |
| `src/setup/prompts.ts` | **编辑** — 嵌入模型选择提示更新 |