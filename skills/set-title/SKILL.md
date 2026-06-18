---
name: set-title
description: >
  Reminds the agent to set the terminal window title via mycc_title tool
  after the session has accumulated meaningful work. Fires after brief or
  recap is called when total tool calls exceed 10 and mycc_title has not
  been used yet this session. Also prompts updating the title when the
  conversation topic has shifted to a different task or focus area.
  Guidelines for titles: keep under 40 characters, describe the current
  task or focus area, prefix with project name if useful (e.g., "mycc:
  fixing bash tool"). Helps users identify which mycc session is which
  across multiple terminal windows or tabs. Fires at most once per
  session — once mycc_title is called, the condition no longer matches.
  Use when you need session identification in multi-window setups,
  terminal tab management, or tracking what each mycc instance is doing.
keywords: [title, terminal, session, reminder, identification, update, window, tab, label, rename, mycc_title, "multi window", workspace]
when: "after brief or recap is used, if total tool calls exceeds 10 and mycc_title has not been used yet this session, then prompt the agent to set a descriptive terminal title"
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
should call `mycc_title` with a concise, descriptive title. The "mycc: "
prefix is added automatically, so pass only the descriptive part like:

- `fixing bash tool`
- `reviewing hook system`
- `adding wiki search`

## Guidelines for title

- Keep it under 40 characters (the "mycc: " prefix is added on top)
- Describe the current task or focus area
- Do NOT include "mycc:" yourself — it's prepended automatically
- **Remember to update the title if the topic has changed, using `mycc_title` tool.**
  When you switch to a different task or the focus of the conversation shifts,
  call `mycc_title` again with a new descriptive title reflecting the current work.

## Notes

- Fires at most once per session (once `mycc_title` is called, the condition
  no longer matches).
