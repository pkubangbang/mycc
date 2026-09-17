---
name: compact-on-intent-trap
description: >
  Recovers you from a stuck loop of bash intent-syntax errors — when you keep
  producing malformed `VERB OBJECT TO PURPOSE` strings and `bash` keeps
  rejecting them with `Error: [Intent]`. It triggers a context compaction
  that brings the intent-language table (verbs, objects, the `TO PURPOSE`
  clause) back into the attention window so you can see the format again. Use
  this when bash intent validation keeps failing despite correction hints and
  the session has grown long enough that attention degradation is the likely
  cause. Fires before `bash` execution when 3+ bash results start with
  `Error: [Intent]` and the session exceeds 20 tool calls; the compaction
  summarises the conversation, restoring the system prompt (including the
  intent language table) to the attention window.
keywords: [intent, trap, bash, compact, context, error, syntax, malformed, recovery, attention, degradation, "intent language"]
when: "before executing bash, if 3 or more bash tool results start with 'Error: [Intent]' (within first 20 chars) and total tool calls exceeds 20, then compact the context"
---

# Compact on Intent Trap

## Purpose

Detect when the LLM is trapped in intent language syntax errors — producing
malformed `VERB OBJECT TO PURPOSE` strings for `bash` calls. When 3+ such
failures accumulate in a long conversation, trigger a context compaction
to restore the intent language table to the attention window.

## Trigger

Fires before `bash` execution when:
- `session.countResult('bash', 'Error: [Intent]', 20) >= 3` — three or more bash tool results start with 'Error: [Intent]' (within first 20 chars)
- `session.count() > 20` — session is large enough that attention degradation is likely

## Action

`compact` — skips the current tool call and triggers `triologue.compact()`, which
summarizes the conversation and replaces it with a compressed version. The system
prompt (including the intent language table) returns to the attention window.

## Notes

- Threshold of 3 (not 2): two failures may be normal self-correction (fail → read
  hint → retry correctly). Three means the LLM can't parse the hint either.
- The `[Intent]` tag in error messages is produced by `judgeBash` in `bash-judge.ts`.
- Compaction is expensive (one LLM summarization call), so this hook fires at
  priority 0 and short-circuits all other hook processing.
