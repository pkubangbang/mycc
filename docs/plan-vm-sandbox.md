# Plan: VM Sandbox — Docker-based Self-Testing for mycc

## Goal

Enable mycc to test itself in isolated Docker containers. A teammate (spawned by lead) controls a Docker container running an autonomous mycc instance. Communication is via JSONL file channels — no TTY, no tmux, no interactive terminal required.

## Architecture

```
用户 → lead (宿主, 持续运行)
        │
        ├── tm_create("experimenter-1", prompt) → teammate 子进程
        │     ├── bash: docker run -d ... (容器)
        │     ├── bash: echo >> input.jsonl → 容器 mycc 执行任务
        │     ├── COLLECT 自动收 mail ← 容器 mycc 的回复
        │     └── mail_to lead: 汇报结果
        │
        └── 汇总 → 用户审查 PR → 合并 → 更新宿主
```

## Communication Channels

Two **independent, orthogonal** env vars control autonomous behavior:

| | only `MYCC_AUTO_IN_JSONL` | only `MYCC_AUTO_OUT_JSONL` | both set | neither |
|---|---|---|---|---|
| **Input source** | File (FileInputProvider) | TTY (UserInputProvider) | File | TTY |
| **process.send check** | Bypassed | Normal | Bypassed | Normal |
| **grant whitelist** | IO dir auto-granted | Not added | IO dir auto-granted | Not added |
| **Terminal output** | Normal (letter box) | Normal (letter box) | Normal (letter box) | Normal |
| **Extra file output** | None | Each reply appended to JSONL | Each reply appended to JSONL | None |
| **question() routing** | Question to terminal, answer from file | TTY (normal) | Question to output file, answer from input file | TTY (normal) |

Key principles:
- `MYCC_AUTO_OUT_JSONL` is **additive** — terminal output continues normally, JSONL file gets an extra copy
- `MYCC_AUTO_IN_JSONL` makes mycc non-interactive — reads from file instead of TTY
- `question()` routes through JSONL whenever `MYCC_AUTO_IN_JSONL` is set — no hang in any combination

Both channels use **append-write + read-and-clear**:

| Channel | Writer | Reader | Multi-line semantics |
|---------|--------|--------|---------------------|
| **auto-in-jsonl** (宿主→容器) | teammate appends | container reads + clears | All lines = **one query** (joined) |
| **auto-out-jsonl** (容器→宿主) | container appends (mailbox format) | teammate COLLECT `collectMails()` | Each line = **one mail** |

## Path Convention

- Session dir: `.mycc/vm-sessions/{teammate-name}/`
- Input file: `.mycc/vm-sessions/{teammate-name}/input.jsonl`
- Output file: teammate's mailbox `.mycc/mail/{teammate-name}.jsonl` (volume-mounted as container's auto-out-jsonl)
- Lead tells teammate these conventions via spawn prompt

## Teammate Workflow

### Phase 1: Setup
```
1. Load skill: vm-sandbox-test
2. Create session dir + IO files with chmod 666:
   mkdir -p .mycc/vm-sessions/{name}
   mkdir -p .mycc/mail
   touch .mycc/vm-sessions/{name}/input.jsonl
   touch .mycc/mail/{name}.jsonl
   chmod 666 .mycc/vm-sessions/{name}/input.jsonl .mycc/mail/{name}.jsonl
3. Start container:
   docker run -d --name {name}-vm \
     -v $(pwd)/.mycc/vm-sessions/{name}/input.jsonl:/io/input.jsonl \
     -v $(pwd)/.mycc/mail/{name}.jsonl:/io/output.jsonl \
     -e MYCC_AUTO_IN_JSONL=/io/input.jsonl \
     -e MYCC_AUTO_OUT_JSONL=/io/output.jsonl \
     -e MYCC_CONTAINER_NAME={name} \
     -e OLLAMA_HOST=http://host.docker.internal:11434 \
     --add-host=host.docker.internal:host-gateway \
     mycc-test:latest --skip-healthcheck
4. Verify: docker ps --filter name={name}-vm
```

### Phase 2: Send Instruction
```
5. Append JSON line to input.jsonl:
   echo '{"content":"给bash工具加--dry-run支持"}' >> .mycc/vm-sessions/{name}/input.jsonl
   → Container reads + clears file, processes as one query
```

### Phase 3: Receive Reply
```
6. Container STOP → appends reply to /io/output.jsonl (mailbox format)
7. Teammate COLLECT → collectMails() → [MAIL] note in triologue
8. Teammate LLM evaluates reply
```

### Phase 4: Handle Questions
```
9.  Container question() → appends QUESTION mail to output.jsonl
10. Teammate COLLECT → sees [MAIL] title="QUESTION"
11. Teammate decides, appends answer to input.jsonl:
    echo '{"content":"y"}' >> .mycc/vm-sessions/{name}/input.jsonl
12. Container question() reads answer, continues
```

### Phase 5: Stop
```
13. docker stop {name}-vm && docker rm {name}-vm
14. rm -rf .mycc/vm-sessions/{name}
15. mail_to("lead", "VM test complete", "summary...")
```

## Deliverables

### 1. `src/loop/file-input-provider.ts` (new file, ~40 lines)

```typescript
import * as fs from 'fs';
import type { InputProvider } from './input-provider.js';

export class FileInputProvider implements InputProvider {
  readonly name = 'file';
  constructor(private inputPath: string, private pollMs = 500) {}

  async getInput(): Promise<string | null> {
    while (true) {
      try {
        const content = fs.readFileSync(this.inputPath, 'utf-8');
        if (content.trim()) {
          fs.truncateSync(this.inputPath, 0);
          const lines = content.trim().split('\n');
          return lines.map(l => JSON.parse(l).content).join('\n');
        }
      } catch { /* file may not exist */ }
      await new Promise(r => setTimeout(r, this.pollMs));
    }
  }

  async promptRetry(): Promise<boolean> { return false; }
}
```

### 2. `src/loop/agent-repl.ts` (modify ~25 lines, 4 changes)

**A — Bypass process.send check:**
```typescript
if (!process.send && !process.env.MYCC_AUTO_IN_JSONL) { ... exit(1) }
```

**B — Use FileInputProvider:**
```typescript
const inputProvider = process.env.MYCC_AUTO_IN_JSONL
  ? new FileInputProvider(process.env.MYCC_AUTO_IN_JSONL)
  : new UserInputProvider(() => (ctx.core as Core).getMode());
```

**C — Auto-grant IO directories:**
```typescript
if (process.env.MYCC_AUTO_IN_JSONL)
  ctx.core.addExternalAutoGrant(path.dirname(process.env.MYCC_AUTO_IN_JSONL));
if (process.env.MYCC_AUTO_OUT_JSONL)
  ctx.core.addExternalAutoGrant(path.dirname(process.env.MYCC_AUTO_OUT_JSONL));
```

**D — Guard process.send() calls:**
```typescript
if (process.send) process.send({ type: 'ready' });
if (process.send) process.send({ type: 'exit' });
```

### 3. `src/loop/states/stop.ts` (modify ~15 lines)

Gated only by `MYCC_AUTO_OUT_JSONL` — additive to terminal output:
```typescript
if (process.env.MYCC_AUTO_OUT_JSONL) {
  const lastMsg = triologue.getMessagesRaw().at(-1);
  if (lastMsg?.content) {
    fs.appendFileSync(process.env.MYCC_AUTO_OUT_JSONL, JSON.stringify({
      id: Math.random().toString(36).substring(2, 10),
      from: process.env.MYCC_CONTAINER_NAME || 'container',
      title: 'Reply',
      content: lastMsg.content,
      timestamp: new Date().toISOString(),
    }) + '\n', 'utf-8');
  }
}
```

### 4. `src/context/parent/core.ts` (modify ~20 lines)

Route `question()` through JSONL when `MYCC_AUTO_IN_JSONL` is set:
```typescript
async question(query: string, asker: string): Promise<string> {
  const hasIn = !!process.env.MYCC_AUTO_IN_JSONL;
  const hasOut = !!process.env.MYCC_AUTO_OUT_JSONL;

  if (hasOut && hasIn) {
    // Full autonomous: question → output file, answer ← input file
    fs.appendFileSync(process.env.MYCC_AUTO_OUT_JSONL, JSON.stringify({
      id: Math.random().toString(36).substring(2, 10),
      from: process.env.MYCC_CONTAINER_NAME || 'container',
      title: 'QUESTION', content: query,
      timestamp: new Date().toISOString(),
    }) + '\n', 'utf-8');
  } else if (hasIn && !hasOut) {
    // Semi-autonomous: question to terminal, answer from file
    this.brief('info', 'question', '--------------------', `${asker} asks`);
    console.log(query);
  } else {
    // Normal: TTY
    this.brief('info', 'question', '--------------------', `${asker} asks`);
    return await agentIO.ask(query);
  }

  // Poll input file for answer (shared with getInput, never simultaneous)
  while (true) {
    try {
      const content = fs.readFileSync(process.env.MYCC_AUTO_IN_JSONL!, 'utf-8');
      if (content.trim()) {
        fs.truncateSync(process.env.MYCC_AUTO_IN_JSONL!, 0);
        return JSON.parse(content.trim().split('\n').at(-1)!).content;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
}
```

### 5. `Dockerfile` (new file, project root)

```dockerfile
FROM node:24-slim
RUN apt-get update && apt-get install -y git build-essential python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN npm link
ENV OLLAMA_HOST=http://host.docker.internal:11434
ENV MYCC_ROOT=/app
ENTRYPOINT ["mycc"]
```

### 6. `.dockerignore` (new file, project root)

```
node_modules
.mycc
.git
docs
*.md
!MYCC.md
```

### 7. Skill: `vm-sandbox-test` (`.mycc/skills/vm-sandbox-test/SKILL.md`)

Pure knowledge — no code. Teaches teammate the orchestration workflow.

```markdown
---
name: vm-sandbox-test
description: >
  Orchestrate a Docker container running an autonomous mycc instance for
  self-testing. Use when you need to test mycc's own behavior in isolation.
  Covers: starting a container with auto-in/out-jsonl channels, sending
  queries, receiving replies via mailbox, evaluating results, cleanup.
keywords: docker, vm, sandbox, container, autonomous, self-test, isolation
---

# VM Sandbox Test

## Prerequisites
- Docker installed on host
- `mycc-test` image built (`docker build -t mycc-test:latest .`)

## Session Setup

1. Create session directory and IO files with open permissions:
   ```bash
   mkdir -p .mycc/vm-sessions/{your-name}
   mkdir -p .mycc/mail
   touch .mycc/vm-sessions/{your-name}/input.jsonl
   touch .mycc/mail/{your-name}.jsonl
   chmod 666 .mycc/vm-sessions/{your-name}/input.jsonl
   chmod 666 .mycc/mail/{your-name}.jsonl
   ```

   Pre-creating files with chmod 666 ensures the container (which may
   run as root or a different UID) can always read and write both files.

2. Start container:
   ```bash
   docker run -d --name {your-name}-vm \
     -v $(pwd)/.mycc/vm-sessions/{your-name}/input.jsonl:/io/input.jsonl \
     -v $(pwd)/.mycc/mail/{your-name}.jsonl:/io/output.jsonl \
     -e MYCC_AUTO_IN_JSONL=/io/input.jsonl \
     -e MYCC_AUTO_OUT_JSONL=/io/output.jsonl \
     -e MYCC_CONTAINER_NAME={your-name} \
     -e OLLAMA_HOST=http://host.docker.internal:11434 \
     --add-host=host.docker.internal:host-gateway \
     mycc-test:latest --skip-healthcheck
   ```

3. Verify container is running:
   ```bash
   docker ps --filter name={your-name}-vm --format '{{.Status}}'
   ```

## Sending Queries

Append a JSON line to the input file:
```bash
echo '{"content":"your instruction here"}' >> .mycc/vm-sessions/{your-name}/input.jsonl
```

The container's FileInputProvider will:
1. Read all lines from /io/input.jsonl
2. Clear the file (truncate to 0)
3. Join all lines as one query
4. Process through the agent loop (LLM → tools → STOP)

## Receiving Replies

Replies arrive automatically in your mailbox. The COLLECT state
collects them and injects as [MAIL] notes. You don't need to poll.

Each container turn (STOP→PROMPT) produces one mail with the
assistant's final reply (title: "Reply").

## Handling Questions from Container

When the container mycc encounters a confirmation prompt (e.g.
plan_on/plan_off with [y/N], git_commit with [y/N], wt_enter with
[y/N]), it routes the question through the output channel as a
mail with title "QUESTION".

When you see a [MAIL] note with title "QUESTION":
1. Read the question content
2. Decide the answer (e.g. "y" or "n")
3. Append the answer to the input file:
   ```bash
   echo '{"content":"y"}' >> .mycc/vm-sessions/{your-name}/input.jsonl
   ```
4. The container's question() will read your answer and continue

IMPORTANT: QUESTION mails require a response. The container is
blocked waiting for your answer. Respond promptly.

## Ending a Session

Send exit by appending empty content or stopping the container:
```bash
echo '{"content":""}' >> .mycc/vm-sessions/{your-name}/input.jsonl
# Or:
docker stop {your-name}-vm && docker rm {your-name}-vm
```

## Cleanup

```bash
docker stop {your-name}-vm 2>/dev/null
docker rm {your-name}-vm 2>/dev/null
rm -rf .mycc/vm-sessions/{your-name}
```

## Evaluation

To evaluate the container's performance:
1. Read the triologue JSONL for full conversation log:
   `read_file .mycc/transcripts/lead-*-triologue.jsonl`
   (if .mycc/transcripts is volume-mounted)
2. Or rely on the mailbox replies for summary-level evaluation
3. Compare against a rubric to score the outcome
```

### 8. Lead spawn prompt template (documentation)

When lead creates a teammate for VM sandbox testing, it uses a prompt like:

```
你是 {teammate-name}，负责操控一个 Docker 容器中的 mycc 实例进行测试。

## 你的身份
- 你的 mailbox: .mycc/mail/{teammate-name}.jsonl（容器回复会自动到达这里）
- 容器输入文件: .mycc/vm-sessions/{teammate-name}/input.jsonl

## 工作流程
1. 加载 skill: vm-sandbox-test（用 skill_load 工具）
2. 按照 skill 的指引创建会话目录、IO 文件并启动容器
3. 向 input.jsonl 追加任务指令：
   echo '{"content":"任务描述"}' >> .mycc/vm-sessions/{teammate-name}/input.jsonl
4. 等待 COLLECT 状态自动收到容器的回复 mail（title: "Reply"）
5. 如果收到 title: "QUESTION" 的 mail，说明容器在等你确认（如 [y/N]），
   你需要决策后把答案追加到 input.jsonl：
   echo '{"content":"y"}' >> .mycc/vm-sessions/{teammate-name}/input.jsonl
   注意：QUESTION 必须及时回复，否则容器会一直阻塞等待
6. 评估容器的回复，决定下一步指令或结束会话
7. 任务完成后停止容器并清理：
   docker stop {teammate-name}-vm && docker rm {teammate-name}-vm
   rm -rf .mycc/vm-sessions/{teammate-name}
8. 用 mail_to 给 lead 发汇总报告

## 注意事项
- 容器中的 mycc 和你用的是同一份代码，只是环境变量不同
- 容器通过 MYCC_AUTO_IN_JSONL 从文件读指令，通过 MYCC_AUTO_OUT_JSONL 往你的 mailbox 写回复
- 你不需要主动轮询回复——COLLECT 状态会自动收集 mailbox
- 如果容器无响应，可以用 docker logs {teammate-name}-vm 检查容器日志
```

## Implementation Order

1. `FileInputProvider` — new file, no dependencies
2. `agent-repl.ts` — 4 changes (bypass, provider, grant, guard)
3. `stop.ts` — auto-out-jsonl output
4. `core.ts` — question() routing
5. `Dockerfile` + `.dockerignore`
6. `vm-sandbox-test` skill
7. Manual integration test

## Future Enhancement (not in this plan)

- `auto << ` prompt: When only `MYCC_AUTO_IN_JSONL` is set (semi-autonomous mode), FileInputProvider could show an `auto << ` prompt for direct user input, appending to the file with proper JSON escaping. This would replace manual `echo >> file` for interactive use. Requires solving the concurrency between `agentIO.ask()` (blocking) and file polling. Deferred to a future iteration.