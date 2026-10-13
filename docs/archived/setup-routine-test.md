# Testing Plan for mycc --setup

## Prerequisites

- `npm link` or `pnpm link` has been run in the mycc project folder
- This makes `mycc` command globally available in the system
- **DO NOT use `node ./bin/mycc.js` or `node src/index.ts`**
- **ALWAYS use `mycc` directly** as the end user would

## Test Method using tmux

### Why tmux?

tmux provides a proper TTY (terminal) environment which is required for the interactive setup wizard. Running commands directly via `bash` tool does not provide a TTY, causing the setup wizard to detect non-interactive mode and exit.

### Step-by-Step Testing Process

```bash
# Step 1: Create a new tmux session
tmux new-session -d -s mycc-test

# Step 2: Navigate to a test directory (simulating user's project folder)
tmux send-keys -t mycc-test 'cd /tmp && mkdir -p mycc-test-project && cd mycc-test-project' Enter

# Step 3: Run the mycc --setup command
tmux send-keys -t mycc-test 'mycc --setup' Enter

# Step 4: Wait for output (interactive prompts)
sleep 2

# Step 5: Capture the screen to see what's displayed
tmux capture-pane -t mycc-test -p

# Step 6: Interact with prompts if needed
tmux send-keys -t mycc-test '1' Enter  # Select option 1 (user-level config)

# Step 7: Capture again after interaction
tmux capture-pane -t mycc-test -p

# Step 8: Clean up when done
tmux kill-session -t mycc-test
```

### Test Scenarios

#### Scenario 1: Fresh Installation (No Existing Config)

```bash
# From a directory with no .mycc-store
tmux new-session -d -s test-fresh
tmux send-keys -t test-fresh 'cd /tmp/fresh-test && mycc --setup' Enter
sleep 2
tmux capture-pane -t test-fresh -p
```

Expected behavior:
- Shows "No existing configuration found" message
- Prompts for config location (user vs project)
- Guides through each environment variable

#### Scenario 2: Re-run Setup (Existing Config)

```bash
# From a directory with existing ~/.mycc-store/.env
tmux new-session -d -s test-existing
tmux send-keys -t test-existing 'cd /tmp/existing-test && mycc --setup' Enter
sleep 2
tmux capture-pane -t test-existing -p
```

Expected behavior:
- Shows current settings (redacted for sensitive values)
- Prompts to reconfigure or keep existing values
- API keys should display as `****xxxx`

#### Scenario 3: Non-Interactive Terminal Detection

```bash
# Run without TTY (should show error message)
echo "" | mycc --setup 2>&1
```

Expected behavior:
- Detects non-interactive terminal
- Shows error message instructing user to run in terminal
- Shows alternative: create config file manually

### Debugging Tips

If the command produces no output:

1. **Check if mycc is linked globally:**
   ```bash
   which mycc
   # Should show path like /usr/local/bin/mycc or ~/.npm-global/bin/mycc
   ```

2. **Check if minimist is parsing --setup flag:**
   - Add debug logging to `src/config.ts`:
     ```typescript
     export function shouldRunSetup(): boolean {
       console.error(`[DEBUG] args = ${JSON.stringify(args)}`);
       console.error(`[DEBUG] args.setup = ${args.setup}`);
       return args.setup === true;
     }
     ```

3. **Check if the setup process is spawning:**
   - Add debug logging in `src/index.ts`:
     ```typescript
     if (shouldRunSetup()) {
       console.error('[DEBUG] Spawning setup wizard...');
       // ...
     }
     ```

4. **Verify bin script passes arguments:**
   - Check `bin/mycc.js` line: `...process.argv.slice(2)`
   - This should pass `--setup` flag through

### Common Issues and Solutions

| Issue | Cause | Solution |
|-------|-------|----------|
| No output at all | `shouldRunSetup()` returns false | Check minimist parsing |
| Setup exits immediately | Non-interactive TTY detection | Use tmux for testing |
| "command not found" | mycc not linked globally | Run `pnpm link` or `npm link` |
| Models not pulling | Ollama not installed | Install Ollama first |

## Running Tests

### Quick Test

```bash
# Create tmux session and run setup
tmux new-session -d -s quick-test
tmux send-keys -t quick-test 'cd /tmp && mycc --setup' Enter
sleep 3
tmux capture-pane -t quick-test -p
```

### Cleanup

```bash
# Kill all test sessions
tmux kill-session -t quick-test 2>/dev/null
tmux kill-session -t mycc-test 2>/dev/null
tmux kill-session -t mycc-setup 2>/dev/null
```