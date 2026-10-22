---
name: brief-isolation
description: >
  Gate that catches `brief` being batched with other tool calls in the same
  turn — a misuse that validateBriefIsolation rejects AFTER the fact by
  answering the whole turn with "Brief must be called alone." Use this whenever
  you are about to call `brief` alongside another tool and want the rule and
  the fix in context before the turn is rejected. A `brief` is a rewind
  anchor: recap collapses the conversation back to the LAST brief, so the
  anchor must stand alone as an unambiguous, self-contained turn boundary.
  Fires once per compaction window: it replaces the batched `brief` call with
  a skill_load of itself (session-scoped `skill_load#brief-isolation` counter,
  reset by compaction), so the rule is reviewed before the rejection round-trip.
keywords: [brief, isolation, alone, batch, batched, tool, call, turn, anchor, recap, rewind, validateBriefIsolation, sole, single, hook, replace, compaction, session]
when: "when brief is called in a turn that also contains other tool calls (turn.count() > 1) and this skill has not been loaded yet this compaction window (session.count('skill_load#brief-isolation') == 0), replace the brief call with a skill_load of this skill so the isolation rule is reviewed before the turn is rejected; do not fire again until a compaction resets the session counter"
---

# Brief Isolation

A gate that fires once per compaction window, `replace`-ing a batched `brief`
call with a `skill_load` of this skill — so the rule below is reviewed BEFORE
`validateBriefIsolation` rejects the whole turn, not narrated alongside the
rejection.

## The rule

`brief` MUST be the **sole tool call of its turn**. No other tool — not
`bash`, not `read_file`, not `plan_off`, not `wiki_prepare`, nothing — may
share the turn with a `brief`.

**Why:** a `brief` is a rewind anchor. `recap` collapses the conversation back
to the LAST brief, so the anchor must be an unambiguous, self-contained turn
boundary. Answering only `brief` in a turn makes that anchor clean;
`validateBriefIsolation` (src/loop/triologue/brief.ts) enforces this by
rejecting the ENTIRE turn — every call in the batch gets the same
"Brief must be called alone" rejection and nothing runs.

## What batching cost in practice

The agent called `brief` together with `plan_off`, `bash`, or `wiki_prepare`
in the same turn. The whole turn was rejected — the brief was NOT posted, the
other tool did NOT run — and the agent had to re-issue everything in the next
turn. Three-plus wasted round-trips per occurrence.

## The fix

If you want to report progress AND do work:

1. **Do the work first** — issue the other tool call(s) alone this turn.
2. **Then `brief` alone** next turn, as the sole call.

If you want to report progress and NOTHING else, issue `brief` alone now.

`recap` carries the same rule (`validateRecapIsolation`) for the same reason.

## After this skill loads — re-decision tree

You just got this content because the hook `replace`-d your batched `brief`
call. Resolve to exactly ONE next action:

- **IF you only wanted to report progress** → re-issue `brief` as the SOLE
  call of the turn.
- **IF you also wanted to do work** → re-issue the OTHER tool call(s) alone
  this turn; save the `brief` for the next turn (or drop it — a brief is
  optional, the work is not).

The gate won't fire again this compaction window (the session counter is now
1), so a correct re-issue proceeds cleanly. The hard backstop
(`validateBriefIsolation` in src/loop/states/hook.ts) still rejects any batch
that slips through.
