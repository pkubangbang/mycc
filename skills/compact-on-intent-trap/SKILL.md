---
name: compact-on-intent-trap
description: >
  When the LLM repeatedly produces malformed bash intent strings (wrong
  verbs, missing TO clause, unknown objects), and the conversation has
  grown large, compact the context to restore attention to the intent
  language format in the system prompt.
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
