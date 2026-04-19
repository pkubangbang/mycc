# Pass-Through Mode Test Cases

Test cases for interactive subprocess support via F12 activation.

## Prerequisites

Before every test session:
1. Create a tmux session: `tmux new-session -s mycc-test -d -x 80 -y 24`
2. Run mycc inside: `tmux send-keys -t mycc-test 'pnpm start --skip-healthcheck' Enter`
3. Wait for the agent prompt to appear
4. Use `tmux send-keys` for input and `tmux capture-pane -t mycc-test -p` for output verification

After all tests:
1. Kill the tmux session: `tmux kill-session -t mycc-test`

---

## Test Case 1: Normal Controlled Mode with Timeout

**Purpose:** Verify bash tool kills process after timeout in controlled mode.

**Steps:**
1. Send prompt: `run cat for me with 3s timeout`
2. Wait for mycc to start the bash tool (look for `[bash]` log)
3. Wait 3+ seconds
4. Capture pane output

**Expected:**
- Process is killed after ~3 seconds
- Tool result contains timeout error message
- mycc returns to agent prompt

---

## Test Case 2: Activate Pass-Through Mode

**Purpose:** Verify F12 activates pass-through mode correctly.

**Steps:**
1. Send prompt: `run cat for me with 30s timeout`
2. Wait for bash tool to start
3. Send F12 key: `tmux send-keys -t mycc-test F12`
4. Wait briefly for attach_ack confirmation
5. Type `hello` and press Enter
6. Verify echo response: `hello`
7. Exit cat with Ctrl+D: `tmux send-keys -t mycc-test C-d`
8. Capture output

**Expected:**
- Timeout is disabled (process not killed after 30s)
- Stdout buffer is replayed correctly (empty for cat initially)
- User can interact with cat: type "hello" + enter, see "hello" echoed
- Ctrl+D exits cat
- mycc returns to controlled mode with tool result

---

## Test Case 3: Non-Interactive Command in Controlled Mode

**Purpose:** Verify short-running commands complete without pass-through.

**Steps:**
1. Send prompt: `run node -e 'console.log(42)' with 5s timeout`
2. Wait for node to finish (should complete quickly)
3. Capture output

**Expected:**
- Output "42" is captured and shown in tool result
- No pass-through activation needed
- Process finishes before timeout
- Controlled mode handles short programs correctly

---

## Test Case 4: Interactive Node REPL in Pass-Through Mode

**Purpose:** Verify interactive REPL works in pass-through mode.

**Steps:**
1. Send prompt: `run node with 60s timeout`
2. Wait for node REPL to start (prompt `>` appears)
3. Send F12 to activate pass-through
4. At the `>` prompt, type `1+1` and press Enter
5. Verify result `2` is shown
6. Type `.exit` or press Ctrl+D twice
7. Capture output

**Expected:**
- REPL responds correctly to `1+1` input
- Result `2` is displayed by node
- `.exit` or Ctrl+D exits the REPL
- Full session output is returned as tool result

---

## Test Case 5: F12 at Agent Prompt Does Not Exit

**Purpose:** Verify F12 outside bash tool does not interfere.

**Steps:**
1. Send prompt: `run sleep 5 with 10s timeout`
2. Wait for sleep to finish (or Ctrl+C to exit early)
3. Wait for agent prompt to return
4. At agent prompt, press F12
5. Wait 2 seconds
6. Send prompt: `echo test`
7. Capture output

**Expected:**
- mycc does NOT exit or crash
- F12 at prompt is harmless (no action or renders innocently)
- Normal enter still works for prompt submission
- mycc responds normally to next input

---

## Test Case 6: Math Operations - Non-Interactive

**Purpose:** Verify simple math in controlled mode.

**Steps:**
1. Send prompt: `run node -e 'console.log(1+1)' with 5s timeout`
2. Wait for node to finish

**Expected:**
- Output "2" returned in tool result
- Process finishes before timeout
- No user interaction needed

---

## Test Case 7: Math Operations - Interactive

**Purpose:** Verify interactive math in pass-through mode.

**Steps:**
1. Send prompt: `run node with 60s timeout`
2. Send F12 to activate pass-through
3. Type `1+1` and press Enter
4. Verify result `2` is shown
5. Type `.exit` or press Ctrl+D twice

**Expected:**
- Interactive REPL works correctly
- Math result displayed
- Clean exit returns to controlled mode

---

## Test Case 8: Buffer Replay on Pass-Through Activation

**Purpose:** Verify stdout buffer is replayed when entering pass-through.

**Steps:**
1. Send prompt: `run 'echo "initial output"; cat' with 30s timeout`
2. Wait for "initial output" to be buffered (brief pause)
3. Send F12 to activate pass-through
4. Capture pane output immediately after F12

**Expected:**
- "initial output" should be visible (buffer replayed)
- cat is running and waiting for input
- User can interact with cat normally

---

## Test Case 9: Timeout Enforcement in Controlled Mode

**Purpose:** Verify timeout kills process in controlled mode.

**Steps:**
1. Send prompt: `run sleep 60 with 3s timeout`
2. Wait 4+ seconds
3. Capture output

**Expected:**
- Process killed after ~3 seconds
- Tool result contains timeout error
- No pass-through activation

---

## Test Case 10: ESC During Pass-Through Mode

**Purpose:** Verify ESC behavior in pass-through mode.

**Steps:**
1. Send prompt: `run cat with 30s timeout`
2. Send F12 to activate pass-through
3. Type some text: `hello world`
4. Press ESC

**Expected:**
- ESC sets interrupted mode in agent loop
- After current tool finishes, agent wraps up
- User can give next instruction

---

## Test Case 11: Multiple Sequential Pass-Through Sessions

**Purpose:** Verify pass-through mode works correctly across multiple invocations.

**Steps:**
1. Send prompt: `run cat with 10s timeout`
2. Send F12, type `test1`, Ctrl+D
3. Wait for tool result
4. Send prompt: `run cat with 10s timeout`
5. Send F12, type `test2`, Ctrl+D
6. Capture output

**Expected:**
- Both sessions work correctly
- Each pass-through activation is independent
- Mode returns to controlled after each session
- Results captured correctly

---

## Test Case 12: Stderr Output in Pass-Through Mode

**Purpose:** Verify stderr is handled correctly.

**Steps:**
1. Send prompt: `run 'node -e "console.error(\"stderr output\"); cat"  ' with 30s timeout`
2. Send F12 to activate pass-through
3. Check that stderr output is visible
4. Ctrl+D to exit cat

**Expected:**
- "stderr output" is displayed
- cat runs interactively after
- Clean exit returns to controlled mode