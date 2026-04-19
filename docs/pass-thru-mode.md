# What is pass-through mode?

For bash tool, when running a program, it normally does not require user's input, and its output will be collected and output as a single `ctx.core.brief` log.

However, there are cases where the program needs the user's input, like `sudo apt-update`. In this case, we need to pass the raw bytes to the program, which forms the below data-flow:

```
user       -> coordinator -> lead -> program in the bash-tool
(keyboard)    (raw mode)     (ipc)   (decoded raw bytes)
```

we call this mode "pass-through", in comparison with the normal "controlled" mode.

In a nutshell, in the "controlled mode", mycc is observing the output; in the "pass-through mode", mycc is handing over the stdio.

# Workflow

As the starting point, the bash tool will start a program with timeout. If after X seconds the program doesn't finish,
then it will be forcibly killed with no mercy, and an error result is returned to the agent loop. This is the controlled
mode behavior.

During the X seconds, the user is allowed to hit `ctrl + enter` to switch (one-way) into the pass-through mode.
The timeout timer will be disabled, and the stdio is connected to the program, so the user can interact with
the program. Since the tools are executed sequentially, the pass-through mode is exclusive to this program.
Once it exits, the mode is returned to controlled mode for the next bash tool call.

## Critical consideration: the stdout buffer
We need to buffer the (initial) raw bytes from the program in case it run interactively.
So when the user hit ctrl + enter, the buffer gets replayed and renders the correct first screen.

To be compatible with the controlled mode, if the buffer is filled up, then it will be 
flushed to the terminal and will not buffer anymore (for this tool).

## Critical consideration: the keystroke to activate pass-through mode
The keystroke is `ctrl + enter`, and it should be only available during the bash tool run.

If for some reason the ctrl + enter is hit outside the bash tool, it should not interfere with the existing behavior like:
- enter on the prompt will exit the program; ctrl + enter should not do anything, or render as a line-feed.
- ctrl + enter should not be interpret as a esc press following some keystroke, causing the program to be interrupted.

# Implementation details

The bash tool calls a dedicated `agentIO.exec()` to start the program with timeout:
```ts
const { result, interrupted } = await agentIO.exec({
    cmd: command,
    cwd: ctx.core.getWorkDir(),
    timeout: timeoutSeconds,
});
```

It's the agentIO's job to handle the stdio correctly. AgentIO should use `execa()` to spin up the program without timeout,
but race with a timeout timer to achieve unconditional sig-kill.

# Test plan

## before every test
Create a tmux session called `mycc-bash` and use it over the entire testing process, only killing it after all is done.
To run mycc inside `mycc-bash` tmux session, using `pnpm start --skip-healthcheck`.
Use send-key and capture-pane as input/output handling.

## 1. the normal flow
1. let mycc run bash tool for you with "run `cat` for me with 3s timeout".
2. Wait for 3s and expect the process to be killed and a message is returned from mycc.

## 2. enable the pass-through
1. let mycc run bash tool for you with "run `cat` for me with 30s timeout".
2. Wait for cat to start (should see mycc indicate the tool is running).
3. Send `ctrl + enter` to activate pass-through mode.
4. Verify:
   - The timeout is disabled (process doesn't get killed after 30s).
   - The stdout buffer is replayed correctly (empty for cat initially).
   - You can interact with cat: type "hello" + enter, expect "hello" echoed back.
5. Exit cat by typing `ctrl + d` or `ctrl + c`.
6. Verify mycc returns to controlled mode and shows the tool result.

## 3. the normal flow with `node`
1. let mycc run bash tool for you with "run `node -e 'console.log(42)'` with 5s timeout".
2. Wait for node to finish (should complete quickly).
3. Verify:
   - The output "42" is captured and shown in the tool result.
   - No pass-through activation needed; controlled mode handles short programs.
4. Also test: "run `node` with 3s timeout" (interactive REPL).
5. Wait 3s and expect the process to be killed (no ctrl+enter pressed).

## 4. using node to do 1+1, both non-interactively and interactively.
### 4a. Non-interactive (controlled mode)
1. let mycc run: "run `node -e 'console.log(1+1)'` with 5s timeout".
2. Expect output "2" returned in tool result.
3. Process finishes before timeout; no user interaction needed.

### 4b. Interactive (pass-through mode)
1. let mycc run: "run `node` with 60s timeout".
2. Send `ctrl + enter` to activate pass-through mode.
3. At the node REPL prompt `>`, type `1+1` and press enter.
4. Verify the result `2` is shown by node (not captured by mycc yet).
5. Type `.exit` or `ctrl + d` twice to exit node.
6. Verify mycc returns the full session output as tool result.

## 5. ctrl + enter at the prompt should not exit
1. let mycc run: "run `sleep 30` with 60s timeout".
2. Send `ctrl + enter` to activate pass-through mode.
3. Wait for sleep to finish (or ctrl+c to exit early).
4. After returning to mycc prompt, verify mycc is ready for next input.
5. At the mycc prompt, press `ctrl + enter`.
6. Verify:
   - mycc does NOT exit.
   - ctrl + enter either does nothing, or renders as a harmless line-feed.
   - Normal enter still works to submit the prompt.
7. Type "hello" and press enter; verify mycc responds normally.

