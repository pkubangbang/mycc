# Bang Command & Tmux Tool Design

## Overview

The `tmux` tool opens an external terminal popup for interactive command execution. The bang command (`!<command>`) is a UI shortcut that calls this tool.

## Two Terminals

| Terminal | Description | Role |
|----------|-------------|------|
| `mycc` | Main agent terminal | Prompts user, captures result |
| `popup` | External tmux terminal | User works interactively |

## Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ MYCC TERMINAL                                                    │
├─────────────────────────────────────────────────────────────────┤
│ agent >> !pnpm build                                            │
│ run cmd ! pnpm build     ← (magenta prompt after typing !)      │
│                                                                 │
│ [popup opens in cwd]                                            │
│                                                                 │
│ Popup opened.                                                   │
│ Reason: Run build with possible prompts                         │
│ Work in popup, then return here.                                │
│ Press Enter to capture & kill, or 'k' to keep session > _       │
│                                                                 │
│ [user presses Enter]                                            │
│                                                                 │
│ ─────────────────────────────────────                           │
│ User ran: pnpm build                                            │
│ Session: mycc-1703123456 (killed)                               │
│ Output: ...                                                     │
│                                                                 │
│ agent >> _                                                      │
└─────────────────────────────────────────────────────────────────┘

For persistent sessions (npm run dev, ssh):

│ Press Enter to capture & kill, or 'k' to keep session > k      │
│                                                                 │
│ ─────────────────────────────────────                           │
│ User ran: npm run dev                                           │
│ Session: mycc-1703123456 (kept)                                  │
│ To reattach: tmux attach -t mycc-1703123456                     │
│ Output: ...                                                     │
```

## Tool Composition

The `tmux` tool is a **workflow lock** combining:

```
┌─────────────────────────────────────────────────────────────┐
│  1. todo: track session name                                 │
│  2. bash: tmux new-session -d -s <name> -c <cwd>            │
│  3. bash: <terminal> -- tmux attach -t <name>               │
│           ↓ (popup opens)                                    │
│  4. question: "Press Enter to capture & kill, or 'k'..."    │
│           ↓ (user confirms)                                  │
│  5. bash: tmux capture-pane -t <name> -p -S -3000          │
│  6. LLM: summarize if too long                               │
│  7. bash: kill-session (if not kept)                         │
│  8. todo: mark done (note: kept/killed)                      │
│           ↓                                                  │
│  9. Return result string                                    │
└─────────────────────────────────────────────────────────────┘
```

**Why track session in todo:**
- Agent can remember active session across turns
- User can reference session name later
- Handles disconnect/reconnect scenarios

## Tool Definition

```typescript
/**
 * tmux.ts - Interactive terminal popup
 *
 * Scope: ['main'] - Lead agent only (requires GUI terminal)
 *
 * Composes: todo + bash(tmux) + question + LLM summarize
 */

import type { ToolDefinition, AgentContext } from '../types.js';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';
import { agentIO } from '../loop/agent-io.js';
import { retryChat, MODEL } from '../ollama.js';

const execAsync = promisify(exec);

export const tmuxTool: ToolDefinition = {
  name: 'tmux',
  description: `Open an interactive terminal popup for user work.

User can run commands, SSH to servers, use interactive programs (vim, htop).
When done, user returns to mycc and presses Enter to capture result.

Use when:
- Commands need user interaction (prompts, passwords)
- SSH sessions to remote servers
- Interactive programs (vim, htop, watch)
- Any task needing direct terminal access`,
  input_schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Initial command (optional). Opens shell if not provided.',
      },
      reason: {
        type: 'string',
        description: 'REQUIRED: Why open terminal? Helps user understand expectations.',
      },
    },
    required: ['reason'],
  },
  scope: ['main'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    return handleTmux(ctx, args);
  },
};

async function handleTmux(ctx: AgentContext, args: Record<string, unknown>): Promise<string> {
  const command = args.command as string | undefined;
  const reason = args.reason as string;
  
  // 1. Prerequisites
  if (!hasTmux()) {
    return `Error: tmux not installed.
  Ubuntu/Debian: sudo apt install tmux
  macOS: brew install tmux`;
  }
  
  const terminalLauncher = detectTerminalLauncher();
  if (!terminalLauncher) {
    return `Error: No external terminal. Use bash tool for non-interactive commands.`;
  }
  
  // 2. Create session
  const cwd = ctx.core.getWorkDir();
  const sessionName = `mycc-${Date.now()}`;
  
  try {
    if (command) {
      const encoded = Buffer.from(command).toString('base64');
      await execAsync(`tmux new-session -d -s ${sessionName} -c "${cwd}" -x 120 -y 40 "bash -c 'eval \$(echo ${encoded} | base64 -d); exec bash'"`);
    } else {
      await execAsync(`tmux new-session -d -s ${sessionName} -c "${cwd}" -x 120 -y 40`);
    }
  } catch (e) {
    return `Error: Failed to create session: ${e}`;
  }
  
  // 3. Track session in todo
  ctx.todo.patchTodoList([{
    id: 0,  // New item
    name: `tmux: ${sessionName}`,
    done: false,
    note: command || '(shell)',
  }]);
  
  // 4. Open popup
  try {
    await execAsync(`${terminalLauncher} -- tmux attach -t ${sessionName}`);
  } catch {
    // Terminal may exit immediately
  }
  
  ctx.core.brief('info', 'tmux', `Opened: ${sessionName}`, reason);
  
  // 5. Wait for user
  console.log(chalk.cyan('\nPopup opened.'));
  console.log(chalk.gray(`Reason: ${reason}`));
  console.log(chalk.gray('Work in popup, then return here.'));
  
  await agentIO.ask(chalk.cyan('Press Enter to capture result > '));
  
  // 6. Capture output
  let output = '';
  let sessionExists = false;
  
  try {
    const { stdout } = await execAsync(`tmux capture-pane -t ${sessionName} -p -S -3000 -E -1 2>/dev/null`);
    output = stdout;
    sessionExists = true;
  } catch {
    // Session closed
  }
  
  // 7. Ask about cleanup
  let keepSession = false;
  if (sessionExists) {
    const answer = await agentIO.ask(chalk.yellow(`Keep tmux session '${sessionName}'? [y/N] > `));
    keepSession = answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
    
    if (!keepSession) {
      try { await execAsync(`tmux kill-session -t ${sessionName}`); } catch {}
      sessionExists = false;
    }
  }
  
  // 8. Update todo
  ctx.todo.patchTodoList([{
    name: `tmux: ${sessionName}`,
    done: true,
    note: keepSession ? 'kept' : 'killed',
  }]);
  
  // 7. Ask about cleanup
  let keepSession = false;
  if (sessionExists) {
    const answer = await agentIO.ask(chalk.yellow(`Keep tmux session '${sessionName}'? [y/N] > `));
    keepSession = answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
    
    if (!keepSession) {
      try { await execAsync(`tmux kill-session -t ${sessionName}`); } catch {}
    }
  }
  
  // 8. Update todo
  ctx.todo.patchTodoList([{
    name: `tmux: ${sessionName}`,
    done: true,
    note: keepSession ? 'kept' : 'killed',
  }]);
  
  // 9. Summarize if needed
  const maxLines = 100;
  const lines = output.split('\n');
  const result = lines.length > maxLines
    ? await summarizeOutput(output, command, maxLines)
    : output || '(empty output)';
  
  // 10. Return
  const header = command ? `User ran: ${command}` : `User worked in terminal`;
  const status = keepSession 
    ? `Session: ${sessionName} (kept)\nTo reattach: tmux attach -t ${sessionName}`
    : `Session: ${sessionName} (killed)`;
  return `${header}\n${status}\nOutput (${lines.length} lines):\n\n${result}`;
}

async function summarizeOutput(output: string, command: string | undefined, maxLines: number): Promise<string> {
  const response = await retryChat({
    model: MODEL,
    messages: [{
      role: 'system',
      content: `Summarize terminal output. Keep under ${maxLines} lines. Preserve errors and exit codes.`
    }, {
      role: 'user',
      content: `${command ? `Command: ${command}\n\n` : ''}${output}`
    }]
  });
  return response.message.content || '(summarization failed)';
}

// Utilities
function detectTerminalLauncher(): string | null {
  if (process.platform === 'darwin') return 'open -a Terminal.app --args';
  const terminals = ['gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm'];
  for (const t of terminals) if (whichSync(t)) return t;
  if (process.platform === 'win32' && whichSync('wt')) return 'wt';
  return null;
}

function hasTmux(): boolean { return whichSync('tmux'); }
function whichSync(cmd: string): boolean {
  try { execSync(`which ${cmd}`, { stdio: 'ignore' }); return true; } catch { return false; }
}
```

## Bang Command UI

The bang command (`!`) is a UI shortcut that calls the tmux tool directly.

### LineEditor Prompt Change

```typescript
// In agentIO.ask()
const query = await agentIO.ask(
  chalk.bgYellow.black('agent >> '),
  true,
  (content) => content.startsWith('!')
    ? chalk.bgMagenta.black('run cmd ! ')
    : chalk.bgYellow.black('agent >> ')
);
```

### Bang Detection in main()

```typescript
// After getting query
if (query.startsWith('!')) {
  const command = query.slice(1).trim();
  const result = await tmuxTool.handler(ctx, {
    command: command || undefined,
    reason: command ? `Run: ${command}` : 'Open terminal',
  });
  triologue.user(`[FYI] ${result}`);
  triologue.resetHint();
  continue;
}
```

## Use Cases

| Use Case | Command | Example |
|----------|---------|---------|
| Run local command | `!pnpm build` | Build with prompts |
| SSH session | `!ssh user@host` | Remote work |
| Interactive edit | `!vim file.txt` | Edit file |
| Open shell | `!` | Free-form work |

## Session Lifecycle

By default, sessions are **killed** after capture to prevent accumulation. But for long-running commands, user can choose to keep:

| User Input | Session State | Use Case |
|------------|---------------|----------|
| `n` (default) | Killed | `pnpm build`, `git push` |
| `y` | Kept | `npm run dev`, `ssh host` |

**Kept sessions are tracked in todo:**
```json
{ "name": "tmux: mycc-1703123456", "done": true, "note": "kept" }
```

**User can reattach manually:**
```
tmux attach -t mycc-1703123456
```

**To list all mycc sessions:**
```
tmux list-sessions | grep mycc
```

## Edge Cases

| Scenario | Handling |
|----------|----------|
| User closes popup early | Capture partial output, ask about cleanup |
| No tmux installed | Show install instructions |
| No terminal launcher | Error, suggest bash tool |
| Long output | Summarize to 100 lines |
| Ctrl+C during question | Session remains, todo shows "kept" |
| Kept session orphaned | User can `tmux list-sessions` and kill manually |

## Implementation Checklist

- [ ] Create `src/tools/tmux.ts`
- [ ] Register in loader
- [ ] Add `onPromptChange` to LineEditor
- [ ] Update `agentIO.ask()` for prompt callback
- [ ] Add bang handling in `main()`
- [ ] Delete `skills/tmux/SKILL.md` (replaced by tool)
- [ ] Update `/help`

## Migration Note

The `skills/tmux/SKILL.md` is **deleted** after implementation. The tool replaces the skill:

| Feature | Skill | Tool |
|---------|-------|------|
| Create session | Manual bash commands | Automated |
| Track session | Manual todo_write | Automatic todo tracking |
| User confirmation | User remembers | Explicit question prompt |
| Capture output | Manual capture-pane | Automatic on confirm |
| Cleanup | Manual kill-session | Automatic cleanup |

The tool provides a locked workflow that the skill couldn't enforce.