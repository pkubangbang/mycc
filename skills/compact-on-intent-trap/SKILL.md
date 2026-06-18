---
name: compact-on-intent-trap
description: >
  Detects when the LLM is trapped in intent language syntax errors —
  repeatedly producing malformed VERB OBJECT TO PURPOSE strings for bash
  calls. When 3 or more bash tool results start with 'Error: [Intent]' and
  the session has grown large enough (>20 tool calls) that attention
  degradation is likely, triggers a context compaction to restore the intent
  language table to the attention window. The intent format requires specific
  verbs (TEST, RUN, BUILD, CHECK, etc.), objects (ARTIFACT, SYSTEM, etc.),
  and a TO PURPOSE clause — when the LLM can no longer see the format table
  due to context length, it falls into repeated syntax errors. Compaction
  summarises the conversation, bringing the system prompt (including the
  intent language table) back into the attention window. Use when the agent
  repeatedly fails bash intent validation with [Intent] errors despite
  receiving correction hints.
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
- `seq.countResult('bash', 'Error: [Intent]', 20) >= 3` — three or more bash tool results start with 'Error: [Intent]' (within first 20 chars)
- `seq.totalCount() > 20` — session is large enough that attention degradation is likely

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
