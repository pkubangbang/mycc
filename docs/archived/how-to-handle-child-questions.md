# How to handle child's questions

Child processes differ from the main process in that **they don't have I/O**.

To report status, child processes will use `brief()` tool and it will go through IPC as `log/error/info` typed message.
From the main process's side, when receiving such messages, the main process will call `brief()` of itself,
which creates an effect of "helping child do brief".

--------

To ask for input, child processes will use `question()` tool and it will go through IPC as `question` typed message.

From the main process's side, when receiving such messages, the main process will buffer them inside `ctx.team` module.
Then at the moment of either:
- The main process enters *a new agent-loop*, or
- The main process is *waiting for all team members* to finish

These buffered questions will be iterated and will call main process's `question()` tool,
which creates an effect of "collect the question from the child processes and ask in a row."

From the child's side, `question()` will put it into `holding` state, and pause the teammate-loop.
Only when the question gets answered will the teammate loop resumes.