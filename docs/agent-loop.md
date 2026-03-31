## 什么是agent loop

agent loop是一个按照STAR原则设计的循环：

1. situation：当前的工作进展是什么，有什么阶段性成果
2. task：告诉大模型，目标是什么
3. action：大模型给出解决办法，程序员写代码解析“解决办法”：
如果使用工具，那就执行工具调用
如果不使用工具，那就结束本次循环，等待用户指令
4. result：收集执行的结果，进入下一次循环。

## 代码描述

```ts
async function agentLoop(
  messages: Message[],
  ctx: AgentContext,
  loader: ToolLoader,
  scope: ToolScope = 'main'
): Promise<{ manualCompact: boolean }> {
  let nextTodoNudge = 3;
  while (true) {
    // collapse old tool call results
    microCompact(messages);

    // read mailbox
    const mails = ctx.mail.collectMails();
    for (const mail of mails) {
        messages.push({
            role: 'user',
            content: `You've got a mail: ${mail.title}` + '\n' + mail.content,
        });
        messages.push({ role: 'assistant', content: 'Noted inbox messages.' });
    }

    // nudge the todo handling
    if (ctx.todo.hasOpenTodo()) {
        nextTodoNudge--;
        if (nextTodoNudge === 0) {
            messages.push({
                role: 'user',
                content: `<reminder>Update your todos. ${ctx.todo.printTodoList}</reminder>`,
            });

            nextTodoNudge = 3;
        }
    }

    // compact the chat history
    if (estimateTokens(messages) > TOKEN_THRESHOLD) {
      console.log(chalk.blue('[auto-compact triggered]'));
      const compacted = await autoCompact(messages);
      messages.splice(0, messages.length, ...compacted);
    }

    // Build system prompt
    const workDir = ctx.core.getWorkDir();
    const skillsDesc = ctx.skill.printSkills();
    const SYSTEM = `You are a coding agent at ${workDir}.
Use task_create/task_update/task_list for multi-step work. Use TodoWrite for short checklists.
Use task for subagent delegation. Use load_skill for specialized knowledge.
Skills: ${skillsDesc}`;

    const tools = loader.getToolsForScope(scope);

    const response = await ollama.chat({
      model: MODEL,
      messages: [{ role: 'system', content: SYSTEM }, ...messages],
      tools,
    });

    const assistantMessage = response.message;
    messages.push({
      role: 'assistant',
      content: assistantMessage.content || '',
      tool_calls: assistantMessage.tool_calls,
    });

    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      const result = await ctx.team.awaitTeam(30000);
      if (result.allSettled) {
        return;
      }

      // Timeout - inject timeout message
      messages.push({
        role: 'user',
        content: `Timeout waiting for teammates. Summarize the intermediate result 
and let me decide what to do. Status of the team: ${ctx.team.printTeam()}`,
      });

      // Continue loop to let agent respond to timeout
      continue;
    }

    // Execute tool calls
    const results: Message[] = [];
    for (const toolCall of assistantMessage.tool_calls) {
      const args = toolCall.function.arguments as Record<string, unknown>;
      const toolName = toolCall.function.name;

      let output: string;
      try {
        output = await loader.execute(toolName, ctx, args);
      } catch (error: unknown) {
        output = `Error: ${(error as Error).message}`;
      }

      results.push({
        role: 'tool',
        content: `tool call ${toolName} finished. ${output}`,
      } as Message);
    }

    // One combined message as tool call result
    messages.push({ role: 'user', content: results.map((r) => r.content).join('\n') });
  }
}
```