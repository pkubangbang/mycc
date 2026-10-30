---
name: set-title
description: >
  Labels the terminal window so the user can tell which mycc session is which
  across multiple windows/tabs — call `mycc_title` with a short (under 40 char)
  description of the current task once the session has meaningful work, and
  again whenever the topic shifts. Use this for multi-window session
  identification and tab management.
  Trigger: the `brief` tool only. Fires as a silent nudge on `brief` once at
  least 12 tool calls have happened since the last `mycc_title` call (or 12 in
  total when none has been set yet), so it re-asks about every dozen calls
  instead of latching off after the first title; after auto-compaction the
  tally resets and it re-arms. Just set the title or stay silent.
  Guidelines for titles: keep under 40 characters, describe the current
  task or focus area, prefix with project name if useful (e.g., "mycc:
  fixing bash tool").
  IMPORTANT discipline: this is a silent nudge. Do NOT write a prose reply
  explaining why you are not setting the title — either call mycc_title, or
  say nothing and continue. If the current focus is the SAME as your existing
  title, stay silent (that discharges the nudge for now); if the work has
  moved on, title it. Note: after auto-compaction the context is summarised,
  so you may genuinely forget an earlier title — then the reminder firing is
  correct and useful.
  Use when you need session identification in multi-window setups,
  terminal tab management, or tracking what each mycc instance is doing.
keywords: [title, terminal, session, reminder, identification, update, window, tab, label, rename, mycc_title, "multi window", workspace]
when: "the moment the agent calls the brief tool, if at least 12 tool calls have happened since its last mycc_title call (or 12 in total when it has not called mycc_title this session yet), then prompt the agent to set or refresh the descriptive terminal title"
---

# Set Terminal Title

## Purpose

Keep the terminal window title describing the CURRENT work. Whenever the agent
calls `brief` and at least 12 tool calls have happened since the last
`mycc_title` (or 12 in total when none has been set), the hook reminds it to
set or refresh the title via `mycc_title`. This lets the user identify which
mycc session is running among multiple terminal windows/tabs.

## Trigger

Fires when:
- `brief` is called (it is the only trigger — this is deliberate)
- `session.count() - session.lastIndex('mycc_title') >= 12`, i.e. 12+ tool
  calls since the last title; with no title yet `lastIndex` is `-1`, so the
  same expression covers the first prompt

Compiled condition:

```
session.count() - session.lastIndex('mycc_title') >= 12
```

Why the interval and not a one-shot latch: a title is not just a label — it
also cuts an archive segment (`mycc_title` → `compactSegment`: the transcript
up to the PREVIOUS title anchor is summarized and spliced in front of the
verbatim tail). A segment under 2000 tokens archives nothing, so a title every
dozen calls is nearly free, while re-asking on every call would re-summarize
the running summary constantly. Do not title more often than the work actually
changes; the interval is the budget.

After auto-compaction the session tally resets (`session.count()` → 0,
`lastIndex` → -1), so the same expression re-arms from scratch — you may
genuinely forget an earlier title then, and the reminder is useful.

## Action

The hook injects this skill body as a reminder. When it fires, call
`mycc_title` with a concise, descriptive title of what you are doing NOW. The
"mycc: " prefix is added automatically, so pass only the descriptive part
like:

- `fixing bash tool`
- `reviewing hook system`
- `adding wiki search`

## Discipline — stay silent, do not explain

This reminder is a **silent nudge**. If the current focus is the SAME as your
existing title, **stay silent** — do NOT write a prose reply such as "no need
to set the title" or "I'll set it later". A prose explanation is the wrong
reply: nobody is waiting for it and it clutters the conversation.

Either:

- call `mycc_title` now with a title reflecting the current work, OR
- say nothing and continue (only when the title already matches).

A later `brief` will ask again after another ~12 calls; that is expected, and
the answer to it is the same one judgement: title if the focus moved.

## Guidelines for title

- Keep it under 40 characters (the "mycc: " prefix is added on top)
- Describe the current task or focus area
- Do NOT include "mycc:" yourself — it's prepended automatically
- When you switch to a different task or the focus of the conversation shifts,
  call `mycc_title` again with a new descriptive title — do not wait for the
  nudge if the shift is obvious.

## Notes

- A title also archives the previous segment. If the work is a long continuous
  investigation with no real topic change, refreshing the title is still
  cheap; it simply archives nothing.
- After auto-compaction the tally is wiped and the reminder re-arms — see
  Trigger. Respond by setting the title or staying silent, not by explaining.
