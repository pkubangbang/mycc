# S11: Autonomous Agents with Child Process Teammates

**Design Document** - Reference implementation for multi-agent orchestration.

## Core Concept: Autonomy

The key insight: **"The agent finds work itself."**

Unlike traditional agent systems where tasks are pushed to agents, autonomous agents actively poll for work, claim tasks, and self-organize. This is similar to how human teams work - people don't wait to be told what to do, they identify work and take ownership.

## Architecture: Lead as Broker

```
┌─────────────────────────────────────────────────────────────┐
│                    Main Process (Lead)                       │
│                                                              │
│  ┌─────────────────┐    ┌─────────────────────────────────┐ │
│  │ TeammateManager │    │        IPC Broker               │ │
│  │                 │    │                                 │ │
│  │ config.json     │    │  Lead → Child: spawn/message     │ │
│  │ processes: Map  │◄───┤  Child → Lead: status/log/error  │ │
│  │ status: Map     │    │  Lead → Child: route messages    │ │
│  └─────────────────┘    └─────────────────────────────────┘ │
│                                                              │
└─────────────────────────────────────────────────────────────┘
         │                    │                    │
         │ IPC                │ IPC                │ IPC
         ▼                    ▼                    ▼
   ┌──────────┐        ┌──────────┐        ┌──────────┐
   │ Worker 1 │        │ Worker 2 │        │ Worker N │
   │ (child)  │        │ (child)  │        │ (child)  │
   └──────────┘        └──────────┘        └──────────┘
```

### Why Lead as Broker?

1. **Simplicity**: Children don't need to know about each other
2. **Centralized State**: Lead tracks all status in memory
3. **Message Routing**: Lead handles all inter-teammate communication
4. **Fault Isolation**: If a child crashes, lead knows and can restart

## Teammate Lifecycle

```
+-------+
| spawn |  ← fork child process, send spawn config via IPC
+---+---+
    |
    v
+-------+  tool_use    +-------+
| WORK  | <----------> |  LLM  |   Agent actively works
+---+---+              +-------+
    |
    | stop_reason != tool_use OR idle tool
    v
+--------+
| IDLE   |  ← Poll every 5s for up to 60s
+---+----+
    |
    +---> check IPC inbox → message? → resume WORK
    |
    +---> scan .tasks/ → unclaimed? → claim → resume WORK
    |
    +---> timeout (60s) → exit process
```

### Key States

- **WORK**: Agent is actively using tools via LLM
- **IDLE**: Agent finished work, waiting for new input
- **SHUTDOWN**: Process terminated

### Idle Behavior

When an agent goes idle, it:
1. Polls IPC inbox for messages (5s interval)
2. Scans `.tasks/` directory for unclaimed tasks
3. After 60s timeout, exits process (saves resources)

This "proactive" idle behavior means teammates can:
- Receive new work from lead
- Discover and claim tasks autonomously
- Self-terminate when no work available

## IPC Message Types

### Parent → Child

```typescript
type ParentMessage =
  | { type: 'spawn'; name: string; role: string; prompt: string; teamName: string }
  | { type: 'message'; from: string; content: string; msgType: string }
  | { type: 'shutdown' };
```

### Child → Parent

```typescript
type ChildMessage =
  | { type: 'status'; status: 'working' | 'idle' | 'shutdown' }
  | { type: 'message'; to: string; content: string; msgType: string }
  | { type: 'log'; message: string }
  | { type: 'error'; error: string };
```

## Task Board Pattern

Tasks are stored as JSON files in `.tasks/` directory:

```json
{
  "id": 1,
  "subject": "Fix login bug",
  "description": "...",
  "status": "pending | in_progress | completed",
  "owner": "alice",
  "blockedBy": [2, 3]
}
```

### Atomic Claiming

```typescript
function claimTask(taskId: number, owner: string): string {
  const taskPath = path.join(TASKS_DIR, `task_${taskId}.json`);
  const task = JSON.parse(fs.readFileSync(taskPath, 'utf-8'));

  // Atomic: read-modify-write
  if (task.status !== 'pending') {
    return `Error: Task ${taskId} already claimed`;
  }

  task.owner = owner;
  task.status = 'in_progress';
  fs.writeFileSync(taskPath, JSON.stringify(task, null, 2));

  return `Claimed task #${taskId} for ${owner}`;
}
```

**Note**: This file-based approach works for single-process leads. For distributed systems, use a database with atomic operations (see `src/context/issue.ts` in the new AgentContext architecture).

## Bounce Pattern

When lead needs to wait for teammates:

```typescript
async function bounce(
  messages: Message[],
  timeoutMs: number = 30000,
  pollIntervalMs: number = 1000
): Promise<{ allSettled: boolean; statusChanges: string[] }> {

  // Send idle nudge to working teammates
  for (const [name, status] of teammates) {
    if (status === 'working') {
      sendTo(name, 'Please finish your current work and enter idle state.');
    }
  }

  // Poll until all settled or timeout
  while (Date.now() - startTime < timeoutMs) {
    const allSettled = Array.from(status.values())
      .every(s => s === 'idle' || s === 'shutdown');

    if (allSettled) {
      // Inject status changes into messages for LLM context
      messages.push({
        role: 'user',
        content: `Teammate status updates:\n${statusChanges.map(c => `  - ${c}`).join('\n')}`
      });
      return { allSettled: true, statusChanges };
    }

    await sleep(pollIntervalMs);
  }

  return { allSettled: false, statusChanges };
}
```

**Why inject status changes?** The LLM needs to know what happened while it was waiting. This "identity re-injection" keeps context fresh.

## Tool Dispatch Pattern

```typescript
const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: (args) => runBash(args.command),
  read_file: (args) => runRead(args.path, args.limit),
  write_file: (args) => runWrite(args.path, args.content),
  edit_file: (args) => runEdit(args.path, args.old_text, args.new_text),
  spawn_teammate: async (args) => TEAM.spawn(args.name, args.role, args.prompt),
  list_teammates: () => TEAM.listAll(),
  // ... more tools
};

// In agent loop
for (const toolCall of assistantMessage.tool_calls) {
  const handler = TOOL_HANDLERS[toolCall.function.name];
  const output = handler ? await handler(toolCall.function.arguments) : 'Unknown tool';
  messages.push({ role: 'tool', content: output });
}
```

This pattern allows:
- Easy addition of new tools
- Type-safe argument handling
- Async/await for all handlers

## Path Safety

All file operations validate paths don't escape workspace:

```typescript
function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}
```

This prevents directory traversal attacks.

## Lessons Learned

### What Works

1. **Child processes for parallelism**: True isolation, no shared state bugs
2. **IPC message broker**: Centralized routing simplifies communication
3. **Task board pattern**: Simple, file-based, human-readable
4. **Idle polling**: Agents can find work autonomously
5. **Bounce pattern**: Clean wait-for-settled semantics

### What Could Improve

1. **Database for tasks**: File-based claiming has race conditions (fixed in AgentContext)
2. **Message queues**: IPC works but message queues (mailboxes) are cleaner
3. **Typed protocols**: String-based message types are error-prone
4. **Graceful degradation**: Better handling of child crashes

### Evolution to AgentContext

The s11 implementation informed the AgentContext architecture:

| s11 Concept | AgentContext Module |
|-------------|---------------------|
| Task files (`.tasks/`) | `issue.ts` (SQLite) |
| Teammate processes | `team.ts` (child processes) |
| IPC messaging | `mail.ts` (append-only files) |
| In-memory status | `team.ts` (SQLite + Map) |
| No skills | `skill.ts` (Markdown + hot-reload) |
| No todos | `todo.ts` (in-memory) |
| No worktrees | `wt.ts` (git worktree) |

## References

- **Electron IPC**: Similar pattern of main process as broker
- **Actor Model**: Each teammate is an actor, lead is the coordinator
- **Work Stealing**: Idle teammates scan for tasks (like thread pools)