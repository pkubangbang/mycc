# Session Management

This design doc demostrates the idea behind the session restoration.

## What is a session

`session` is like vscode-workspace file which is a metadata including:
- session id (an uuid)
- created time (new Date().toISOString())
- project dir(process.cwd)
- lead triologue (only one)
- child's triologue (many)
- all related teammate (list of only names)
- user's first query -- this serves as a bookmark title

## How to persist a session

Session is persisted in two ways:

1. When the agent starts, a new session file will be created in `.mycc/sessions`. Certain events
will update its content, for example:
   - the first user query will update the bookmark title
   - `tm_create` tool call will add a teammate to the list
   - the ready state of teammate will add a child triologue path
2. When `/save` the slash-command is used, the same session file will be copied into the user's home (`~/.mycc/sessions`).

We call the first case "project session" and the second case "user session".

Also noted, **session is not mirrored in memory but only read from file every time it is used.** This spares the effort of syncing.

Saved sessions can be manually loaded; Only when the lead's triologue is empty should the triologue load a session.

## How to restore a session?

**Session is designed to only be partially restored.** In other words, session restoration is lossy.

To restore a session, the user should use `/load` the slash-command. If no arguments are given,
then a list of saved sessions are shown to the terminal; the list consists of sessions in current dir (i.e. project session) 
as well as in home dir (i.e. user session); if there's colliding session ids, the user session will shadow the other.

If an argument is given, it is taken as the session id.

**To load a project session, read the below; to load a user session, first find the corresponding project one by the project dir property inside the session file, then after a simple validation load the project one.**

Before loading a session, the agent must check the existence of all triologue files recorded inside the session file.
Only when all the files exist and are well-formed should the agent continues to load.

When loading a session, the agent first summarize the child's triologue files, each into a "pair", then process the triologue of the lead, injecting child's summary at the `tm_create` places.

The "pair" is a pair of chat messages. 
- The first one's role is `user`, the content being the summary-for-continuity.
- The second one's role is `assistant`, the content is simply an acknowledgement.

To process the triologue, cut out the first batch according to `TOKEN_THRESHOLD` and use llm to summarize into a pair, then add more chats to form the second batch and go on, until the end is met. Throughout the process, the old session file + triologue files are kept intact.

After loading a session, a temporary markdown file is generated and shown to the user, much like what `git commit`
would do if no commit message is given, to let the user add extra instructions before starting this new session. This markdown
file is called `DOSQ`, short for "document of status quo". After the DOSQ is saved, the instructions in the DOSQ will be the new session's `first user's query` (but actually is the 3rd chat, the 1st and the 2nd is the summary pair).

All the missing parts such as team setup and todo/issues are expected to have the agent consolidate on its own.

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
5. The user uses `/load bbcde7` to load the session. Behind the scene, the llm is busy processing the triologue.
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
4. Later the user starts the agent again in a random folder, and use `/load ff3588` to load the session.
5. The agent will set to new workdir and read the project session files + triologue files and restore the session.
6. If for some reason the project has moved to a new place, let the user decide the correct place. The agent will then update the user session file to reconciliate.

## Implementation details
Pay attention to the triologue module: it's used by the main process and the child processes, so you
shouldn't add logic specific to main process there. Instead, create a sessionUtil to do that.

| hook | source | action(callback) |
|---------|--------|---------|
| onTeammateCreate | triologue | update project session file's teammate field     |
| onFirstQuery     | triologue | update project session file's user's first query |
| onTeammateReady  | IPC call  | update teammate's triologue paths |
| /save            | slash-cmd | copy project session to user session |
| /load xxx        | slash-cmd | prepare the transcripts, feed into triologue |


## Appendix: summarizeTriologue algorithm
1. Given a list of messages, and a TOKEN_THRESHOLD as the input.
2. Prepare an empty list called buffer.
3. Load the buffer with messages until meet the THRESHOLD
4. Use llm to summarize the buffer into a pair; then empty the buffer.
5. Push the pair into the buffer, then repeat #3 until all messages are processed.
6. Summarize the buffer again and take the result as the output.