## 什么是agent loop

agent loop是一个按照STAR原则设计的循环：

1. situation：当前的工作进展是什么，有什么阶段性成果
2. task：告诉大模型，目标是什么
3. action：大模型给出解决办法，程序员写代码解析"解决办法"：
如果使用工具，那就执行工具调用
如果不使用工具，那就结束本次循环，等待用户指令
4. result：收集执行的结果，进入下一次循环。

## 核心机制

### microCompact - 工具结果压缩

`microCompact()` 将连续的 tool 消息合并为单个 user 消息，减少消息历史长度：

```ts
// Before microCompact:
// [user, assistant, tool, tool, tool, assistant, tool, ...]

// After microCompact:
// [user, assistant, user("Previous tool results: ..."), assistant, user("Previous tool results: ...")]
```

每次循环开始时调用，避免历史消息过长。

### autoCompact - LLM 智能压缩

当 token 估计值超过 `TOKEN_THRESHOLD` (50000) 时触发：

1. 保存完整历史到 `.mycc/transcripts/transcript_{timestamp}.jsonl`
2. 让 LLM 生成摘要，包含：
   - 已完成的工作
   - 当前状态
   - 关键决策
3. 用摘要替换历史消息

```ts
if (estimateTokens(messages) > TOKEN_THRESHOLD) {
  console.log(chalk.blue('[auto-compact triggered]'));
  const compacted = await autoCompact(messages);
  messages.splice(0, messages.length, ...compacted);
}
```

### Todo Nudging - 任务提醒

每 3 次循环检查一次 open todos，提醒 agent 更新进度：

```ts
let nextTodoNudge = 3;
// ...
if (ctx.todo.hasOpenTodo()) {
  nextTodoNudge--;
  if (nextTodoNudge === 0) {
    messages.push({
      role: 'user',
      content: `<reminder>Update your todos. ${ctx.todo.printTodoList()}</reminder>`,
    });
    nextTodoNudge = 3;
  }
}
```

### Team Awaiting - 等待队友完成

当 agent 没有工具调用时，检查 team 状态：

```ts
if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
  if (ctx.team) {
    const result = await ctx.team.awaitTeam(30000);
    if (result.allSettled) {
      return;
    }
    messages.push({
      role: 'user',
      content: `Timeout waiting for teammates. ${ctx.team.printTeam()}`,
    });
    continue;
  }
  return;  // No team, single agent - just return
}
```

## 代码描述

```ts
async function agentLoop(
  messages: Message[],
  ctx: AgentContext,
  toolLoader: ToolLoaderImpl,
  scope: ToolScope = 'main'
): Promise<void> {
  let nextTodoNudge = 3;

  while (true) {
    // 1. Micro-compact old tool results
    microCompact(messages);

    // 2. Collect mails
    const mails = ctx.mail.collectMails();
    for (const mail of mails) {
      messages.push({
        role: 'user',
        content: `Mail from ${mail.from}: ${mail.title}\n${mail.content}`,
      });
      messages.push({ role: 'assistant', content: 'Noted.' });
    }

    // 3. Todo nudging
    if (ctx.todo.hasOpenTodo()) {
      nextTodoNudge--;
      if (nextTodoNudge === 0) {
        messages.push({
          role: 'user',
          content: `<reminder>Update your todos. ${ctx.todo.printTodoList()}</reminder>`,
        });
        nextTodoNudge = 3;
      }
    }

    // 4. Auto-compact when tokens exceed threshold
    if (estimateTokens(messages) > TOKEN_THRESHOLD) {
      console.log(chalk.blue('[auto-compact triggered]'));
      const compacted = await autoCompact(messages);
      messages.splice(0, messages.length, ...compacted);
    }

    // 5. Build system prompt
    const SYSTEM = buildSystemPrompt(ctx);

    // 6. Call LLM
    const response = await ollama.chat({
      model: MODEL,
      messages: [{ role: 'system', content: SYSTEM }, ...messages],
      tools: toolLoader.getToolsForScope(scope),
    });

    // 7. Handle response
    const assistantMessage = response.message;
    messages.push({
      role: 'assistant',
      content: assistantMessage.content || '',
      tool_calls: assistantMessage.tool_calls,
    });

    // 8. No tool calls = check team status
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      if (ctx.team) {
        const result = await ctx.team.awaitTeam(30000);
        if (result.allSettled) {
          return;
        }
        messages.push({
          role: 'user',
          content: `Timeout waiting for teammates. ${ctx.team.printTeam()}`,
        });
        continue;
      }
      return;  // No team means single agent - just return
    }

    // 9. Execute tools
    for (const toolCall of assistantMessage.tool_calls) {
      const args = toolCall.function.arguments as Record<string, unknown>;
      const toolName = toolCall.function.name;

      const output = await toolLoader.execute(toolName, ctx, args);

      messages.push({
        role: 'tool',
        content: `tool call ${toolName} finished.\n${output}`,
      });
    }
  }
}
```

## System Prompt

系统提示根据上下文动态构建：

### Lead Agent (有 team)

```ts
`You are the lead of a coding agent team at ${workDir}.
You spawn teammates, create issues and collect results.
Use tools to finish tasks. Use skills to access specialized knowledge.
Report proactively using the brief tool.
Read README.md or CLAUDE.md first if you feel lost about the context.
You must ask for grant BEFORE "git commit" with no exception.
Skills: ${skills}`
```

### Single Agent (无 team)

```ts
`You are a coding agent at ${workDir}.
Use tools to finish tasks. Use skills to access specialized knowledge.
Consider using issue_* to divide and conquor complex tasks, using todo_* for simple task tracking.
You must ask for grant BEFORE "git commit" with no exception.
Skills: ${skills}`
```

### Child Agent (teammate)

```ts
`You are a specialized agent working as part of a team.
Use skills to access specialized knowledge.
Use question tools to ask question to the user,
use brief tools to report your progress,
use mail_to tools to communicate with other teammates.
Prefer concise and frank communication style.
When you feel lost about the context, send mail to "lead".

[IDENTITY]
Name: ${name}
Role: ${role}
Working Directory: ${workDir}
[/IDENTITY]

Skills: ${skills}`
```

## 工具执行

工具执行后，结果直接作为 `tool` 角色消息添加到历史：

```ts
for (const toolCall of assistantMessage.tool_calls) {
  const args = toolCall.function.arguments as Record<string, unknown>;
  const toolName = toolCall.function.name;

  const output = await toolLoader.execute(toolName, ctx, args);

  messages.push({
    role: 'tool',
    content: `tool call ${toolName} finished.\n${output}`,
  });
}
```

注意：工具结果是逐条添加，不是合并为一条消息。`microCompact()` 会在下次循环时处理连续的 tool 消息。