# MYCC helper scripts

This folder contains internal scripts that MYCC uses to enhance its capabilities.

## mdcalc

MYCC as a LLM harness is not good at simple math computation.

Instead of writing python which is effective but not informative,
I made a script that receives a specialized md file and compute inside it like using Excel.

## pretty-print

MYCC has crossroad feature: when hitting a turning word, it will trigger a "best of 3"
choice to decide where to go. After the decision making, the original text is continued
by the chosen words.

However, if you would like MYCC to repeat the whole sentence, it will fail because the
same words will trigger the crossroad again, and the continuation is doomed to change.

So I made a script that takes a "crossroad json" file and output the whole sentence
verbosely using bash, which surpass the crossroad behavior.

Later I found this mechanism to worth a generalization: pretty-print's essence is to
add viewing logic to an already structural file, so MYCC will have a better understanding
of the content.

> Note that this feature is under developement, and the final design
> may be drastically different than the current.

## clear-session
A skill called "clear-sessions" will guide MYCC to clean up the session files
to save the disk space. The skill's action is locked down as a script.

MYCC is smart enough to run the script or emulate the script-run based on the
platform it lives.

## tp-violation

A provider-enforced invariant keeps biting mycc's message history: an
`assistant` message with `tool_calls` must be followed by `tool` messages
answering every `tool_call_id` before any other role. DeepSeek enforces it with
HTTP 400; Ollama silently tolerates it — so a sequence that breaks in
production passes in development.

`scripts/tp-violation/probe.mjs` drives the **real** `Triologue` facade through
every producer mix that can interpose a note with tool calls outstanding, then
posts the facade's own output to the live provider. See
[`tp-violation/README.md`](tp-violation/README.md) for the rule, the reproduced
400, and the deferral design.

Coverage note (2026-10-09): the deferral guard (`note()`/`user()` defer while
the ledger is non-empty) closes the *interposition* class. Two further append
paths were audited against the same invariant:

- `tool()` with no preceding assistant (`tool_no_assistant` recovery) only
  fires when the ledger is EMPTY (a non-empty ledger always leaves the last
  role as `assistant`/`tool`), so its injected block is standalone and legal —
  pinned by a facade-driven regression test.
- `finishWrapUp()` previously pushed to the store DIRECTLY, bypassing every
  check. It now flushes any outstanding call and routes through `addMessage`
  (the single append chokepoint), so a wrap-up assistant can never be streamed
  inside an open tool_calls block.

Both are covered by facade-driven tests in
`src/tests/loop/triologue.test.ts` (`deferred-input guard` describe block).