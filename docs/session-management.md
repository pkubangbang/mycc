# Session Management

This design doc helps guide the AI agent to implement the session module.

## What is a session

Session in this project refers to a continuous dialogue between the user and the agent, starting from 
when user use `mycc` to start the agent, ending with the user `/exit`, hit enter at the prompt or similiar alike.

Session contains working status, like todo list, issues, team setup, mails, worktrees, and so on.
Not all of them are persistent, and even persistent, most of them get cleared out on start to make the
working environment clean.

With the above discussion, `session` is implemented as a file containing metadata of the dialogue.
Some important fields are:
- session id (an arbitrary hash)
- created time
- project starting workdir
- lead trialogue (only one)
- child's trialogue (many)
- user's first query -- this serves as a bookmark title

## Is session persistent?

Session is persistent. It is automatically synced inside the local folder (`.mycc/sessions` + `.mycc/transcripts`),
and can be manually saved into user's home dir (`~/.mycc/sessions`).

Saved sessions can be manually loaded; it is only permitted to load only one session when the agent starts, and once
a session has been loaded, no other sessions can be loaded during this session.

Session files are designed to accomodate sudden poweroff; so the below fields won't be included:
- session end time
- total token count
- chat history length
- team member list
- summary of current progress


## How to restore a session?

Session is designed to only be partially restored. In other words, session restoration is lossy.
All the data other than **the chat messages** are not guaranteed to be kept the same as before;
Even the chat messages themselves could be adapted or compacted.

To restore a session, the user should use `/load` the slash-command. If no arguments are given,
then a list of saved sessions are shown to the terminal and the agent returns to REPL prompt.
If an argument is given, it is taken as the session id.

Only one session can be loaded, and only when the chat history is clean could the agent load the session.

Before loading a session, the agent must check the existence of all trialogue files.
Only when all the files exist and are well-formed should the agent continues to load.

When loading a session, the agent first summarize the child's trialogue files, then process the trialogue of the lead,
injecting child's summary at the `tm_remove`, `tm_dismiss` places or at the end if the teammate is still alive.

The lead's trialogue is holistic without compaction. To process the trialogue, cut out the first batch according to `TOKEN_THRESHOLD` and use llm to summarize into one user query with one agent acknowledgement, then takes as the start of
the second batch and go on, until the end is met. Throughout the process, the old session file + trialogue files are
kept intact.

After loading a session, a temporary markdown file is generated and shown to the user, much like what `git commit`
would do if no commit message is given, to let user add extra information before starting this new session. This markdown
file is called `DOSQ`, short for "document of status quo".

The processed message, as well as the DOSQ will be combined to be the first user query to the agent, also the first record inside lead's trialogue.

All the missing parts such as team setup and todo/issues are expected to let the agent consolidate on its own.

## Example workflow: /save and /load

### natural ending
1. The user has finished the work, and hit `Enter` at the prompt to exit the agent.
2. All the working status is kept there without cleaning.
3. The user starts the agent again; during start, the db get's initialized, thus removing the data.
4. The user uses `/load` slash-command; the previous session is shown in a list, like:
   ```
   [session bbcde7]
   created at: xxxxxx
   workdir: xxxx
   teammates in the record: [a, b, c]
   first words: 
   xxxxxxxxxxxxxxxxxxxxxxx

   ```
5. The user uses `/load bbcde7` to load the session. Behind the scene, the llm is busy processing the trialogue.
6. A temporary markdown (DOSQ) is shown with instructions to let the user add custom information, waiting for the user to save or discard.
7. If saved, a new session file is created, and the agent runs. The session is restored.

### abrupt ending
1. The user for some reason hit Ctrl + C to break the agent and back to bash.
2. The user start the agent again using `mycc`
3. The user uses `/load` to show all previous sessions.
4. The user uses `/load bbcde7` to load a session.
5. (same as above)

### saving a session
1. The user has reached a milestone of the work, and wanted to save the session for later use.
2. The user uses `/save` slash-command, and the agent will copy the session file from the project folder to the user's home, like `cp /var/proj/proj-kcoin/.mycc/sessions/session-ff3588.json /home/pkubangbang/.mycc/sessions`. After that a log is shown in the terminal "session saved at ~/.mycc/sessions. You can use `/load ff3588` to restore the session."
3. The user exits the agent.
4. Later the user starts the agent again, and use `/load ff3588` to load the session.
5. The agent will set to new workdir and read the session files + trialogue files and restore the session.
6. If for some reason the project has moved to a new place, let the user decide the correct place. The agent will then check the identity of session files in the home dir as well as the new project dir to reconciliate.