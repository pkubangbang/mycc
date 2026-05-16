---
name: set-title
description: >
  Reminds the agent to set the terminal window title when `brief` or `recap`
  is used, the session has accumulated enough tool calls (>10), and the
  title has not been set yet. Helps identify sessions across multiple
  terminal windows.
keywords: [title, terminal, session, reminder, identification]
when: if brief or recap is used, and the total tool calls has exceeded 10, and mycc_title is not used yet, then prompt the agent to set a descriptive terminal title
---

# Set Terminal Title

## Purpose

After 10+ tool calls in a session, when the agent calls `brief` or `recap` to
report progress, remind it to set the terminal window title via `mycc_title`.
This lets the user identify which mycc session is running among multiple
terminal windows/tabs.

## Trigger

Fires when:
- `brief` or `recap` is called
- Total tool calls in this session > 10
- `mycc_title` has not been called yet this session

## Action

The hook injects this skill body as a reminder. On the next turn, the agent
should call `mycc_title` with a concise, descriptive title like:

- `mycc: fixing bash tool`
- `mycc: reviewing hook system`
- `mycc: adding wiki search`

## Guidelines for title

- Keep it under 40 characters
- Describe the current task or focus area
- Prefix with the project name if useful (e.g., `mycc:`)
- Update it when focus changes

## Notes

- Fires at most once per session (once `mycc_title` is called, the condition
  no longer matches).
