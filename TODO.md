- [x] Make the ollama api call more error-proof.
- [x] Refine the log output
- [x] Detect missing env and show an instuction to the user to add it.
- [x] Add a `-v` flag on start to generate a detailed log for troubleshooting.
- [x] Support multi-line editing and pasting (using popup temp file)
- [x] (Important!) Make Ctrl + C to reliably break the agent running and exit.
- [x] (Important!) Enable mycc to use SSH via tmux.
# about the /load slash command
- [x] `/load <sessionid>` should allow partial (but un-ambigious) match.
- [x] `/load <sessionid>` should be able to load any available session, no matter it being a user session or a project session.
- [x] `/load <sessionid>` should ensure the working dir is what recorded inside the session file; it's like `cd <proj-dir> && mycc --session <sessionid-full>`.

- [x] remove sqlite dependency (we have session)
- [ ] prompt history navigation is not working
- [x] "project tool" and "user tool" not working due to ts-js compatibility