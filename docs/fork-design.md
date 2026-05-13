# fork slash command - design doc

The `/fork` slash command gives mycc a way to `run a new version of itself` in parallel.

## workflow

1. In a mycc instance, after the code changes, the user enters `/fork` in the prompt and submit
2. It is interpreted as a slash command.
3. Mycc will get the current session id, open up the terminal, and simulate a `mycc --session <session-id>` inside
that terminal (with cwd equal the current cwd), to start a new mycc from current chat history.
4. The old mycc instance is kept as-is, so two versions of mycc can run in parallel.

## Special notice

To test this functionality, you need to use the screen tool rather than the tmux tool, because otherwise you cannot 
see what's going on inside the new terminal.

The way to start a new mycc instance can be found in src/index.ts. The core principle is using tsx rather than the bare nodejs.

The "starting mycc" procedure is not stable now. Please think hard and produce a robust solution.