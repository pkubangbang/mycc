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
  across multiple terminal windows or tabs.
  IMPORTANT discipline: this is a silent nudge. If you receive this
  reminder and judge it is NOT the time to set/update the title (e.g. the
  title was already set this session and the topic has not shifted, or the
  work is not yet meaningful enough), STAY SILENT — do NOT write a prose
  reply explaining why you are not setting the title. Either call
  mycc_title now, or say nothing and continue the task. A prose "no need to
  set the title" response is the wrong behavior: it does not satisfy the
  condition, so the reminder will keep firing, and it clutters the
  conversation. Note: after auto-compaction the context is summarised, so
  you may genuinely forget an earlier title — in that case the reminder
  re-firing is correct and useful; just set the title (or stay silent) and
  move on.
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

Note: after auto-compaction the tool-call tally is wiped, so the condition
may re-arm. That is intentional — compaction summarises the context, so you
may genuinely forget an earlier title, and the reminder usefully re-fires.
When it does, set the title (or stay silent — see Discipline below) and
continue; do not write a prose reply about it.

## Action

The hook injects this skill body as a reminder. On the next turn, the agent
should call `mycc_title` with a concise, descriptive title. The "mycc: "
prefix is added automatically, so pass only the descriptive part like:

- `fixing bash tool`
- `reviewing hook system`
- `adding wiki search`

## Discipline — stay silent, do not explain

This reminder is a **silent nudge**. If you receive it and judge it is NOT
the time to set or update the title (e.g. you already set one this turn and
the topic has not shifted, or the work is not yet meaningful enough to
label), **stay silent** — do NOT write a prose reply such as "no need to set
the title" or "I'll set it later". Either:

- call `mycc_title` now with a descriptive title, OR
- say nothing and continue the current task.

A prose "no need" response is the wrong behavior: it does not satisfy the
condition (`mycc_title` was not called), so the reminder will keep firing on
later `brief`/`recap` calls, and the explanation clutters the conversation.
The correct response to a nudge you don't want to act on is silence.

## Guidelines for title

- Keep it under 40 characters (the "mycc: " prefix is added on top)
- Describe the current task or focus area
- Do NOT include "mycc:" yourself — it's prepended automatically
- **Remember to update the title if the topic has changed, using `mycc_title` tool.**
  When you switch to a different task or the focus of the conversation shifts,
  call `mycc_title` again with a new descriptive title reflecting the current work.

## Notes

- The reminder may re-fire after auto-compaction (the tool-call tally is
  wiped by compaction). This is intentional — see Trigger. Respond by setting
  the title or staying silent, not by explaining.
- **Remember to update the title if the topic has changed**, using the
  `mycc_title` tool — call it again with a new descriptive title reflecting
  the current work.
