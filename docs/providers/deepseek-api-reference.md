# DeepSeek API 技术参考文档

> 基于 https://api-docs.deepseek.com/zh-cn/api/create-chat-completion 整理
>
> Base URL: `https://api.deepseek.com`
>
> Beta Base URL: `https://api.deepseek.com/beta`

---

## 1. 对话补全 (Chat Completions)

```
POST https://api.deepseek.com/chat/completions
```

根据输入的上下文，让模型补全对话内容。

### 1.1 认证

```bash
Authorization: Bearer <DEEPSEEK_API_KEY>
```

### 1.2 可用模型

| 模型 ID | 说明 |
|---------|------|
| `deepseek-v4-pro` | 旗舰模型，最强推理能力 |
| `deepseek-v4-flash` | 快速模型，低延迟 |

---

## 2. 请求结构 (Request Body)

### 2.1 顶层字段一览

| 字段 | 类型 | 必需 | 默认值 | 说明 |
|------|------|------|--------|------|
| `messages` | `object[]` | **是** | — | 对话消息列表 |
| `model` | `string` | **是** | — | 模型 ID，可选 `deepseek-v4-flash` / `deepseek-v4-pro` |
| `thinking` | `object` | 否 | — | 思考模式开关，`{"type": "enabled"/"disabled"}` |
| `reasoning_effort` | `string` | 否 | `"high"` | 推理强度：`high` / `max`；`low`/`medium` 映射为 `high`，`xhigh` 映射为 `max`；复杂 Agent 请求自动设为 `max` |
| `max_tokens` | `integer` | 否 | — | 生成 completion 的最大 token 数 |
| `response_format` | `object` | 否 | — | 输出格式，见 §2.6 |
| `stop` | `object` | 否 | — | 停止序列（最多 16 个） |
| `stream` | `boolean` | 否 | `false` | `true` 时以 SSE 流式发送增量，以 `data: [DONE]` 结尾 |
| `stream_options` | `object` | 否 | — | 流式选项，见 §2.8 |
| `temperature` | `number` | 否 | `1` | 采样温度，范围 (0, 2] |
| `top_p` | `number` | 否 | `1` | 核采样，范围 (0, 1] |
| `tools` | `object[]` | 否 | — | 工具/函数定义列表，最多 128 个，见 §2.9 |
| `tool_choice` | `object` | 否 | — | 工具选择策略，见 §2.10 |
| `logprobs` | `boolean` | 否 | `false` | 是否返回输出 token 的对数概率 |
| `top_logprobs` | `integer` | 否 | — | 返回 top-N 概率 token，范围 [0, 20]，需 `logprobs=true` |
| `user_id` | `string` | 否 | — | 用户标识，字符集 `[a-zA-Z0-9\-_]`，最大 512 字符 |
| `frequency_penalty` | — | — | — | **已废弃**，传入无效 |
| `presence_penalty` | — | — | — | **已废弃**，传入无效 |

### 2.2 messages — 消息对象

`messages` 是一个数组，每条消息为以下四种角色之一（`oneOf`）：

#### System message（系统消息）

```json
{
  "role": "system",
  "content": "You are a helpful assistant",
  "name": "optional-system-name"
}
```

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `role` | `string` | 是 | 固定值 `"system"` |
| `content` | `string` | 是 | 系统消息文本内容 |
| `name` | `string` | 否 | 参与者名称 |

#### User message（用户消息）

```json
{
  "role": "user",
  "content": "What is the weather?",
  "name": "optional-user-name"
}
```

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `role` | `string` | 是 | 固定值 `"user"` |
| `content` | `string` 或 content-parts | 是 | 用户消息文本或富文本内容 |
| `name` | `string` | 否 | 参与者名称 |

#### Assistant message（助手消息）

```json
{
  "role": "assistant",
  "content": "The weather is sunny.",
  "reasoning_content": "Let me think about this...",
  "tool_calls": [...],
  "name": "optional-assistant-name",
  "prefix": false
}
```

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `role` | `string` | 是 | 固定值 `"assistant"` |
| `content` | `string` | 否 (nullable) | 助手回复内容 |
| `reasoning_content` | `string` | 否 | 思考模式下的推理链内容 |
| `tool_calls` | `object[]` | 否 | 模型生成的工具调用列表 |
| `name` | `string` | 否 | 参与者名称 |
| `prefix` | `boolean` | 否 | (Beta) 对话前缀续写模式，需设置 `base_url="https://api.deepseek.com/beta"` |

#### Tool message（工具消息）

```json
{
  "role": "tool",
  "content": "24°C",
  "tool_call_id": "call_xxxxxxxx"
}
```

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `role` | `string` | 是 | 固定值 `"tool"` |
| `content` | `string` | 是 | 工具执行结果 |
| `tool_call_id` | `string` | 是 | 对应的工具调用 ID |

### 2.3 thinking — 思考模式开关

```json
{
  "thinking": {
    "type": "enabled"   // "enabled" 或 "disabled"
  }
}
```

- 默认思考开关为 `"enabled"`
- 与 `reasoning_effort` 配合使用控制思考强度
- 使用 OpenAI SDK 时需将 `thinking` 传入 `extra_body`（作为 `create()` 的第三个参数）：

```typescript
const response = await client.chat.completions.create(
  {
    model: 'deepseek-v4-pro',
    messages: messages,
    reasoning_effort: 'high',
  },
  {
    body: { thinking: { type: 'enabled' } },
  }
);
```

### 2.4 reasoning_effort — 思考强度

| 值 | 说明 |
|----|------|
| `"high"` | 默认强度，适用于普通请求 |
| `"max"` | 最高强度，复杂 Agent 类请求（Claude Code、OpenCode 等）自动采用 |
| `"low"` / `"medium"` | 兼容映射 → `"high"` |
| `"xhigh"` | 兼容映射 → `"max"` |

> **注意**：思考模式下不支持 `temperature`、`top_p`、`presence_penalty`、`frequency_penalty` 参数。设置不会报错，但也不会生效。

### 2.5 max_tokens — 最大输出 Token

限制模型生成 completion 的最大 token 数。输入 + 输出 token 总长度受模型上下文长度限制。

### 2.6 response_format — 输出格式

```json
// 普通文本模式
{ "type": "text" }

// JSON 模式
{ "type": "json_object" }
```

JSON 模式要求：
- system 或 user prompt 中必须含有 `json` 字样，并给出期望的 JSON 格式样例
- 需合理设置 `max_tokens`，防止 JSON 被截断
- 如果 `finish_reason="length"`，表示生成超过 max_tokens 或上下文长度，内容可能被截断

### 2.7 stop — 停止序列

最多 16 个停止序列。模型遇到任一序列时停止生成。

### 2.8 stream_options — 流式选项

```json
{
  "stream_options": {
    "include_usage": true   // 是否在流式响应末尾包含 usage 信息
  }
}
```

### 2.9 tools — 工具定义

```json
{
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get weather of a location",
        "parameters": {
          "type": "object",
          "properties": {
            "location": {
              "type": "string",
              "description": "The city name"
            }
          },
          "required": ["location"]
        },
        "strict": false
      }
    }
  ]
}
```

**function 对象字段：**

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `name` | `string` | 是 | 函数名，字符集 `[a-zA-Z0-9_-]`，最大 64 字符 |
| `description` | `string` | 否 | 函数功能描述，供模型理解 |
| `parameters` | `object` | 否 | JSON Schema 描述输入参数，省略表示空参数列表 |
| `strict` | `boolean` | 否 | 默认 `false`。是否启用 strict 模式 (Beta) |

最多支持 128 个 function。

### 2.10 tool_choice — 工具选择策略

控制模型如何选择工具：

```json
// 不调用任何工具
"tool_choice": "none"

// 模型自主决定（默认）
"tool_choice": "auto"

// 必须调用工具
"tool_choice": "required"

// 强制调用指定函数
"tool_choice": {
  "type": "function",
  "function": {
    "name": "get_weather"
  }
}
```

---

## 3. 响应结构 (Response Body)

### 3.1 非流式响应 (200 OK)

```json
{
  "id": "930c60df-bf64-41c9-a88e-3ec75f81e00e",
  "choices": [
    {
      "finish_reason": "stop",
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! How can I help you today?",
        "reasoning_content": "The user is greeting me...",
        "tool_calls": [
          {
            "id": "call_xxxxxxxx",
            "type": "function",
            "function": {
              "name": "get_weather",
              "arguments": "{\"location\":\"Beijing\"}"
            }
          }
        ]
      }
    }
  ],
  "created": 1718345013,
  "model": "deepseek-v4-pro",
  "system_fingerprint": "fp_a49d71b8a1",
  "object": "chat.completion",
  "usage": {
    "completion_tokens": 10,
    "prompt_tokens": 16,
    "prompt_cache_hit_tokens": 0,
    "prompt_cache_miss_tokens": 16,
    "total_tokens": 26,
    "completion_tokens_details": {
      "reasoning_tokens": 5
    }
  }
}
```

#### 顶层字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 对话唯一标识符 |
| `choices` | `object[]` | 模型生成的 completion 选择列表 |
| `created` | `integer` | Unix 时间戳（秒） |
| `model` | `string` | 生成该 completion 的模型名 |
| `system_fingerprint` | `string` | 后端配置指纹 |
| `object` | `string` | 固定值 `"chat.completion"` |
| `usage` | `object` | Token 用量详情 |

#### choices[].message 对象

| 字段 | 类型 | 说明 |
|------|------|------|
| `role` | `string` | 固定值 `"assistant"` |
| `content` | `string` (nullable) | 模型生成的回复内容 |
| `reasoning_content` | `string` (nullable) | 思考模式下的推理链内容 |
| `tool_calls` | `object[]` | 模型生成的工具调用 |
| `tool_calls[].id` | `string` | 工具调用 ID |
| `tool_calls[].type` | `string` | 固定值 `"function"` |
| `tool_calls[].function.name` | `string` | 调用的函数名 |
| `tool_calls[].function.arguments` | `string` (JSON) | 函数参数 JSON 字符串，需自行验证合法性 |

#### choices[].finish_reason

| 值 | 说明 |
|----|------|
| `stop` | 模型自然停止或遇到 stop 序列 |
| `length` | 达到 max_tokens 或上下文长度上限 |
| `content_filter` | 输出内容触发过滤策略 |
| `tool_calls` | 模型发起了工具调用 |
| `insufficient_system_resource` | 系统推理资源不足，生成被打断 |

#### usage 对象

| 字段 | 类型 | 说明 |
|------|------|------|
| `prompt_tokens` | `integer` | 输入消耗的 token 数 `= cache_hit + cache_miss` |
| `prompt_cache_hit_tokens` | `integer` | 命中上下文缓存的 token 数 |
| `prompt_cache_miss_tokens` | `integer` | 未命中缓存的 token 数 |
| `completion_tokens` | `integer` | 输出产生的 token 数 |
| `total_tokens` | `integer` | 总 token 数（prompt + completion） |
| `completion_tokens_details.reasoning_tokens` | `integer` | 思考模式消耗的推理 token 数 |

### 3.2 流式响应 (200 Streaming)

以 SSE (Server-Sent Events) 形式发送增量消息。

**每个 chunk 结构：**

```json
{
  "id": "1f633d8bfc032625086f14113c411638",
  "choices": [
    {
      "index": 0,
      "delta": {
        "role": "assistant",
        "content": "Hello",
        "reasoning_content": null,
        "tool_calls": null
      },
      "finish_reason": null,
      "logprobs": null
    }
  ],
  "created": 1718345013,
  "model": "deepseek-v4-pro",
  "system_fingerprint": "fp_a49d71b8a1",
  "object": "chat.completion.chunk",
  "usage": null
}
```

**delta 对象字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `role` | `string` | 角色（仅在首个 chunk 中出现） |
| `content` | `string` (nullable) | 增量文本内容 |
| `reasoning_content` | `string` (nullable) | 思考模式下的增量推理内容 |
| `tool_calls` | `object[]` (nullable) | 增量工具调用信息 |

**流结束标记：**
```
data: [DONE]
```

**注意：**
- `object` 值为 `"chat.completion.chunk"`（区别于非流式的 `"chat.completion"`）
- 流式响应中 `usage` 通常为 `null`，除非 `stream_options.include_usage=true`（最后一个 chunk 会包含 usage）

---

## 4. 思考模式 (Thinking Mode)

DeepSeek 模型在输出最终回答前，先输出思维链内容以提升准确度。

### 4.1 启用方式

| 用途 | OpenAI 格式 | Anthropic 格式 |
|------|------------|---------------|
| 开关 | `{"thinking": {"type": "enabled"/"disabled"}}` | — |
| 强度 | `{"reasoning_effort": "high"/"max"}` | `{"output_config": {"effort": "high"/"max"}}` |

### 4.2 输入输出规则

- 思维链通过 `reasoning_content` 字段返回，与 `content` 同级
- 思考模式下 `temperature`、`top_p` 等参数设置后不生效（但不报错）

### 4.3 多轮对话拼接规则

| 场景 | reasoning_content 处理 |
|------|----------------------|
| 无工具调用 | 中间 assistant 的 `reasoning_content` 在后续轮次中**不需要**拼接，传入也会被忽略 |
| 有工具调用 | 中间 assistant 的 `reasoning_content` **必须**在所有后续轮次中回传给 API，否则返回 400 错误 |

拼接方式（推荐）：
```typescript
// 直接 push 整个 message 对象即可
messages.push(response.choices[0].message);

// 等价于：
messages.push({
  role: 'assistant',
  content: response.choices[0].message.content,
  reasoning_content: response.choices[0].message.reasoning_content,
  tool_calls: response.choices[0].message.tool_calls,
});
```

### 4.4 OpenAI SDK 注意事项

使用 OpenAI SDK (TypeScript) 时，`thinking` 参数必须通过 `create()` 的第三个参数传入：

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: '<KEY>',
  baseURL: 'https://api.deepseek.com',
});

const response = await client.chat.completions.create(
  {
    model: 'deepseek-v4-pro',
    messages: messages,
    reasoning_effort: 'high',
  },
  {
    body: { thinking: { type: 'enabled' } },
  }
);

// 访问思维链
const reasoning = response.choices[0].message.reasoning_content;
const answer = response.choices[0].message.content;
```

---

## 5. 工具调用 (Tool Calls)

### 5.1 非思考模式基本用法

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: '<KEY>',
  baseURL: 'https://api.deepseek.com',
});

const tools = [
  {
    type: 'function' as const,
    function: {
      name: 'get_weather',
      description: 'Get weather of a location',
      parameters: {
        type: 'object',
        properties: {
          location: {
            type: 'string',
            description: 'The city name',
          },
        },
        required: ['location'],
      },
    },
  },
];

const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
  { role: 'user', content: "How's the weather in Hangzhou?" },
];

const response = await client.chat.completions.create({
  model: 'deepseek-v4-pro',
  messages,
  tools,
});

// 获取工具调用
const toolCalls = response.choices[0].message.tool_calls!;
messages.push(response.choices[0].message);

// 执行函数并将结果回传
messages.push({
  role: 'tool',
  tool_call_id: toolCalls[0].id,
  content: '24°C',
});

// 再次请求获取最终回答
const finalResponse = await client.chat.completions.create({
  model: 'deepseek-v4-pro',
  messages,
});
console.log(finalResponse.choices[0].message.content);
```

### 5.2 思考模式下的工具调用

从 DeepSeek-V3.2 开始支持。思考模式下的工具调用与普通工具调用有**两个关键区别**：

1. **多轮思考循环**：模型在输出最终答案之前，可以进行多轮的"思考 → 工具调用 → 获取结果 → 再思考"循环。每次工具调用结果返回后，模型可能继续调用更多工具，直到它认为信息足够才输出最终答案。
2. **reasoning_content 必须回传**：进行了工具调用的轮次，在**后续所有请求**（包括同一 Turn 内的子请求和后续 Turn）中，**必须**完整回传 `reasoning_content` 给 API，否则 API 会返回 **400 错误**。

#### 调用流程图

```
Turn N 开始
  │
  ├─ Sub-turn 1: 用户提问
  │   ├─ 模型输出: reasoning_content ("我需要先获取日期...")
  │   ├─ 模型输出: tool_calls: [get_date()]
  │   └─ 用户代码: 执行 get_date() → 结果 "2026-04-20"
  │
  ├─ Sub-turn 2: 携带 reasoning_content + tool result
  │   ├─ 模型输出: reasoning_content ("日期已获取，现在查天气...")
  │   ├─ 模型输出: tool_calls: [get_weather(location="Hangzhou", date="2026-04-20")]
  │   └─ 用户代码: 执行 get_weather() → 结果 "Cloudy 7~13°C"
  │
  ├─ Sub-turn 3: 携带所有 reasoning_content + tool result
  │   ├─ 模型输出: reasoning_content ("天气结果已获取，告知用户...")
  │   └─ 模型输出: content: "杭州明天的天气：多云，7°C~13°C"
  │                   tool_calls: null (无工具调用，循环结束)
  │
  └─ Turn N 结束

Turn N+1 开始 (新问题)
  │
  ├─ Sub-turn 1: 必须携带 Turn N 所有 reasoning_content
  │   ├─ 模型继续推理...
  │   └─ ...
```

#### 完整代码示例

```typescript
import OpenAI from 'openai';

// 工具定义
const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_date',
      description: 'Get the current date',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get weather of a location, supply location and date.',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'The city name' },
          date: { type: 'string', description: 'Date in format YYYY-mm-dd' },
        },
        required: ['location', 'date'],
      },
    },
  },
];

// 模拟工具实现
function getDateMock(): string {
  return new Date().toISOString().slice(0, 10);
}

function getWeatherMock(location: string, date: string): string {
  return 'Cloudy 7~13°C';
}

const TOOL_CALL_MAP: Record<string, (...args: any[]) => string> = {
  get_date: getDateMock,
  get_weather: getWeatherMock,
};

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
});

async function runTurn(
  turn: number,
  messages: OpenAI.Chat.ChatCompletionMessageParam[]
): Promise<void> {
  /** 执行一个 Turn，内部循环处理多轮工具调用直到模型输出最终答案 */
  let subTurn = 1;
  while (true) {
    const response = await client.chat.completions.create(
      {
        model: 'deepseek-v4-pro',
        messages,
        tools,
        reasoning_effort: 'high',
      },
      {
        body: { thinking: { type: 'enabled' } },
      }
    );

    const assistantMsg = response.choices[0].message;
    messages.push(assistantMsg);

    const reasoningContent = assistantMsg.reasoning_content;
    const content = assistantMsg.content;
    const toolCalls = assistantMsg.tool_calls;

    console.log(`Turn ${turn}.${subTurn}`);
    console.log(`  reasoning: ${reasoningContent}`);
    console.log(`  content:   ${content}`);
    console.log(`  tool_calls: ${JSON.stringify(toolCalls)}`);

    // tool_calls 为 undefined/null → 模型已给出最终答案，退出循环
    if (!toolCalls) {
      break;
    }

    // 执行每个工具调用，将结果追加到 messages
    for (const tool of toolCalls) {
      const toolFunc = TOOL_CALL_MAP[tool.function.name];
      const args = JSON.parse(tool.function.arguments);
      const toolResult = toolFunc(...Object.values(args));
      console.log(`  tool result for ${tool.function.name}: ${toolResult}`);
      messages.push({
        role: 'tool',
        tool_call_id: tool.id,
        content: toolResult,
      });
    }
    subTurn++;
  }
}

// === 使用示例 ===
async function main() {
  // Turn 1: 第一个问题
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'user', content: "How's the weather in Hangzhou Tomorrow" },
  ];
  await runTurn(1, messages);

  // Turn 2: 第二个问题（messages 中保留了 Turn 1 的 reasoning_content）
  messages.push({ role: 'user', content: "How's the weather in Guangzhou Tomorrow" });
  await runTurn(2, messages);
}

main();
```

#### 关键实现细节

**1. 消息拼接方式**

`response.choices[0].message` 是完整的 assistant 消息对象，包含 `content`、`reasoning_content`、`tool_calls` 等所有字段。直接 push 即可：

```typescript
messages.push(response.choices[0].message);

// 以上代码等价于:
messages.push({
  role: 'assistant',
  content: response.choices[0].message.content,
  reasoning_content: response.choices[0].message.reasoning_content,
  tool_calls: response.choices[0].message.tool_calls,
});
```

**2. 循环终止条件**

检查 `tool_calls` 是否为 undefined/null：
- `!toolCalls` → 模型输出了最终答案（仅有 `content`），循环结束
- `toolCalls` 有值 → 模型想调用工具，需要执行工具并继续循环

**3. 跨 Turn 的 reasoning_content 传递**

- Turn 1 结束后 `messages` 中已包含所有 sub-turn 的 reasoning_content
- Turn 2 发送请求时，这些 reasoning_content 会一起传给 API
- 如果漏传任何一个有工具调用的 assistant 消息中的 reasoning_content，API 返回 **400 错误**

**4. reasoning_content 回传规则总结**

| 轮次类型 | 是否需要回传 reasoning_content |
|----------|---------------------------|
| 无工具调用的 assistant 消息 | **不需要**，传入也会被忽略 |
| 有工具调用的 assistant 消息 | **必须**在所有后续请求中回传 |
| 同一 Turn 内的子请求 | **必须**携带该 Turn 之前 sub-turn 的 reasoning_content |
| 后续 Turn 的请求 | **必须**携带之前所有 Turn（含有工具调用）的 reasoning_content |

### 5.3 Strict 模式 (Beta)

开启方法：
1. 设置 `base_url="https://api.deepseek.com/beta"`
2. 所有 function 设置 `"strict": true`
3. 所有 object 设置 `"additionalProperties": false`
4. 所有属性必须列在 `required` 中

```json
{
  "type": "function",
  "function": {
    "name": "get_weather",
    "strict": true,
    "description": "Get weather of a location",
    "parameters": {
      "type": "object",
      "properties": {
        "location": {
          "type": "string",
          "description": "The city name"
        }
      },
      "required": ["location"],
      "additionalProperties": false
    }
  }
}
```

#### Strict 模式支持的 JSON Schema 类型

| 类型 | 支持的约束 | 不支持 |
|------|-----------|--------|
| `object` | `properties`, `required`（全部属性必须列出）, `additionalProperties: false` | — |
| `string` | `pattern`（正则）, `format`（`email`/`hostname`/`ipv4`/`ipv6`/`uuid`） | `minLength`, `maxLength` |
| `number` / `integer` | `const`, `default`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf` | — |
| `boolean` | — | — |
| `array` | `items` | `minItems`, `maxItems` |
| `enum` | 确保输出为预设选项之一 | — |
| `anyOf` | 匹配多个 schema 中的任一 | — |
| `$ref` / `$def` | 模块化定义和引用，支持递归结构 | — |

---

## 6. JSON Output

### 6.1 启用方式

```typescript
const response = await client.chat.completions.create({
  model: 'deepseek-v4-pro',
  messages,
  response_format: { type: 'json_object' },
});
```

### 6.2 必要条件

1. 设置 `response_format={'type': 'json_object'}`
2. system 或 user prompt 中必须包含 `json` 字样和期望的 JSON 格式样例
3. 合理设置 `max_tokens` 防止 JSON 截断

### 6.3 完整示例

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: '<KEY>',
  baseURL: 'https://api.deepseek.com',
});

const systemPrompt = `
The user will provide some exam text. Parse "question" and "answer", output JSON.

EXAMPLE INPUT: 
Which is the highest mountain? Mount Everest.

EXAMPLE JSON OUTPUT:
{
    "question": "Which is the highest mountain?",
    "answer": "Mount Everest"
}
`;

const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
  { role: 'system', content: systemPrompt },
  { role: 'user', content: 'Which is the longest river? The Nile River.' },
];

const response = await client.chat.completions.create({
  model: 'deepseek-v4-pro',
  messages,
  response_format: { type: 'json_object' },
});

const result = JSON.parse(response.choices[0].message.content!);
// result = { question: "...", answer: "..." }
```

---

## 7. 完整请求示例

### 7.1 cURL

```bash
curl -L -X POST 'https://api.deepseek.com/chat/completions' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -H 'Authorization: Bearer <TOKEN>' \
  --data-raw '{
    "messages": [
      {"content": "You are a helpful assistant", "role": "system"},
      {"content": "Hi", "role": "user"}
    ],
    "model": "deepseek-v4-pro",
    "thinking": {"type": "enabled"},
    "reasoning_effort": "high",
    "max_tokens": 4096,
    "response_format": {"type": "text"},
    "stream": false,
    "temperature": 1,
    "top_p": 1
  }'
```

### 7.2 TypeScript

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: '<KEY>',
  baseURL: 'https://api.deepseek.com',
});

const response = await client.chat.completions.create(
  {
    model: 'deepseek-v4-pro',
    messages: [
      { role: 'system', content: 'You are a helpful assistant' },
      { role: 'user', content: 'Hi' },
    ],
    reasoning_effort: 'high',
    max_tokens: 4096,
    temperature: 1,
    top_p: 1,
  },
  {
    body: { thinking: { type: 'enabled' } },
  }
);

console.log(response.choices[0].message.content);
```

### 7.4 流式调用

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: '<KEY>',
  baseURL: 'https://api.deepseek.com',
});

const stream = await client.chat.completions.create({
  model: 'deepseek-v4-pro',
  messages: [{ role: 'user', content: 'Tell me a story' }],
  stream: true,
});

for await (const chunk of stream) {
  const delta = chunk.choices[0].delta;
  if (delta.content) {
    process.stdout.write(delta.content);
  }
}
```

### 7.5 流式 + 工具调用 + 思考模式

```typescript
const stream = await client.chat.completions.create(
  {
    model: 'deepseek-v4-pro',
    messages,
    tools,
    stream: true,
    reasoning_effort: 'high',
  },
  {
    body: { thinking: { type: 'enabled' } },
  }
);

for await (const chunk of stream) {
  const delta = chunk.choices[0].delta;
  if (delta.reasoning_content) {
    console.log(`[思考] ${delta.reasoning_content}`);
  }
  if (delta.content) {
    console.log(`[回答] ${delta.content}`);
  }
  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      console.log(`[工具调用] ${tc.function.name}(${tc.function.arguments})`);
    }
  }
}
```

---

## 8. 关键注意事项汇总

1. **思考模式 + OpenAI SDK (TypeScript)**：`thinking` 参数必须通过 `create()` 的第三个参数 `{ body: { thinking: { type: 'enabled' } } }` 传入
2. **思考模式限制**：不支持 temperature/top_p 等采样参数
3. **多轮推理拼接**：有工具调用时必须回传 `reasoning_content`，否则 400 错误
4. **工具调用参数验证**：模型生成的 function arguments 不保证是合法 JSON，需要自行验证
5. **JSON Output**：prompt 中必须含 `json` 字眼和样例，否则可能生成空白
6. **max_tokens**：JSON 模式下注意设置足够大，防止截断
7. **frequency_penalty / presence_penalty**：已废弃，不要使用
8. **user_id**：不要包含用户隐私信息
9. **Strict 模式**：Beta 功能，需使用 beta base URL，且所有 object 必须设置 `additionalProperties: false`
